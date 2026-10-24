"""Tencent Cloud CVM inventory, monitoring and lifecycle for the Workbench."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from octop.api.deps import current_user, get_server
from pydantic import BaseModel, Field

from octop.infra.cloud.tencent import (
    CRED_REFRESH_SAFE_S,
    CloudCredential,
    CloudCredentialStore,
    CloudError,
    build_authorization,
    credential_from_ticket,
    decode_ticket,
    instance_action,
    list_instances,
    list_regions,
    query_cluster_trend,
    query_latest_metrics,
    query_metrics,
    refresh_credential,
    require_credential,
)

router = APIRouter()


class CallbackBody(BaseModel):
    code: str = Field(min_length=1)
    state: str | None = None


class ActionBody(BaseModel):
    region: str = Field(min_length=1)
    instance_id: str = Field(min_length=1)
    action: str = Field(pattern="^(start|stop|reboot)$")


class BatchMetricsBody(BaseModel):
    instances: list[dict[str, str]] = Field(default_factory=list)


class ClusterTrendBody(BaseModel):
    instances: list[dict[str, str]] = Field(default_factory=list)
    minutes: int = Field(default=60, ge=5, le=10080)
    period: int = Field(default=60, ge=60, le=86400)
    max_instances: int = Field(default=12, ge=1, le=40)


def _store(server: Any) -> CloudCredentialStore:
    return CloudCredentialStore(server.paths.root)


def _uid(user: Any) -> int:
    return int(user.id)


def _status_payload(credential: CloudCredential | None) -> dict[str, Any]:
    if credential is None:
        return {"authorized": False, "state": "missing", "can_refresh": False}
    remaining = int(credential.expires_at - time.time())
    if remaining > CRED_REFRESH_SAFE_S:
        return {
            "authorized": True,
            "state": "valid",
            "expires_at": credential.expires_at,
            "remaining_seconds": remaining,
            "can_refresh": credential.can_refresh(),
        }
    return {
        "authorized": False,
        "state": "expired",
        "expires_at": credential.expires_at,
        "remaining_seconds": remaining,
        "can_refresh": credential.can_refresh(),
    }


@router.get("/status")
async def status(
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    store = _store(server)
    uid = _uid(user)
    credential = store.load(uid)
    # STS tickets live ~2h, but a stored refresh_token can mint a new one. Renew
    # silently instead of forcing the user through the QR flow again.
    if (
        credential is not None
        and credential.remaining() <= CRED_REFRESH_SAFE_S
        and credential.can_refresh()
    ):
        try:
            credential = await asyncio.to_thread(refresh_credential, credential)
        except CloudError:
            pass
        else:
            store.save(uid, credential)
    return _status_payload(credential)


@router.post("/authorize")
async def authorize(
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    store = _store(server)
    state = store.new_state(_uid(user))
    return {"auth_url": build_authorization(state), "state": state, "expires_in": 600}


@router.post("/callback")
async def callback(
    body: CallbackBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    uid = _uid(user)
    try:
        ticket = decode_ticket(body.code)
    except CloudError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    store = _store(server)
    verified = store.consume_state(uid, body.state or str(ticket.get("state") or ""))
    if verified is False:
        raise HTTPException(status_code=409, detail="授权链接已失效，请重新发起授权")

    try:
        credential = await asyncio.to_thread(credential_from_ticket, ticket)
    except CloudError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    store.save(uid, credential)
    return _status_payload(credential)


@router.post("/refresh")
async def refresh(
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    uid = _uid(user)
    store = _store(server)
    credential = store.load(uid)
    if credential is None:
        return {"authorized": False, "state": "missing", "can_refresh": False}
    try:
        renewed = await asyncio.to_thread(refresh_credential, credential)
    except CloudError as exc:
        return {
            "authorized": False,
            "state": "expired",
            "can_refresh": False,
            "error": str(exc),
        }
    store.save(uid, renewed)
    return _status_payload(renewed)


@router.delete("")
async def logout(
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    return {"cleared": _store(server).clear(_uid(user))}


@router.get("/regions")
async def regions(
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    store = _store(server)
    try:
        credential = await asyncio.to_thread(require_credential, store, _uid(user))
        items = await asyncio.to_thread(list_regions, credential)
    except CloudError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - SDK errors vary
        raise HTTPException(status_code=502, detail=f"地域查询失败: {exc}") from exc
    return {"regions": items}


@router.get("/instances")
async def instances(
    region: list[str] | None = Query(default=None),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    store = _store(server)
    try:
        credential = await asyncio.to_thread(require_credential, store, _uid(user))
        if region:
            targets = list(region)
        else:
            found = await asyncio.to_thread(list_regions, credential)
            targets = [item["id"] for item in found]
        items = await asyncio.to_thread(list_instances, credential, targets)
    except CloudError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - SDK errors vary
        raise HTTPException(status_code=502, detail=f"实例查询失败: {exc}") from exc
    return {"instances": items, "regions": targets}


@router.get("/metrics")
async def metrics(
    region: str = Query(min_length=1),
    instance_id: str = Query(min_length=1),
    minutes: int = Query(default=60, ge=5, le=10080),
    period: int = Query(default=60, ge=60, le=86400),
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    store = _store(server)
    try:
        credential = await asyncio.to_thread(require_credential, store, _uid(user))
        return await asyncio.to_thread(
            query_metrics,
            credential,
            region=region,
            instance_id=instance_id,
            minutes=minutes,
            period=period,
        )
    except CloudError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - SDK errors vary
        raise HTTPException(status_code=502, detail=f"监控查询失败: {exc}") from exc


@router.post("/metrics/batch")
async def metrics_batch(
    body: BatchMetricsBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    targets: list[dict[str, str]] = []
    for item in body.instances[:1000]:
        region = (item.get("region") or "").strip()
        instance_id = (item.get("instance_id") or "").strip()
        if region and instance_id:
            targets.append({"region": region, "instance_id": instance_id})
    if not targets:
        return {"sampled_at": int(time.time()), "items": {}}
    store = _store(server)
    try:
        credential = await asyncio.to_thread(require_credential, store, _uid(user))
        return await asyncio.to_thread(
            query_latest_metrics, credential, targets=targets
        )
    except CloudError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - SDK errors vary
        raise HTTPException(status_code=502, detail=f"批量监控查询失败: {exc}") from exc


@router.post("/metrics/cluster-trend")
async def metrics_cluster_trend(
    body: ClusterTrendBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    targets: list[dict[str, str]] = []
    for item in body.instances[:1000]:
        region = (item.get("region") or "").strip()
        instance_id = (item.get("instance_id") or "").strip()
        if region and instance_id:
            targets.append({"region": region, "instance_id": instance_id})
    if not targets:
        return {"sampled_at": int(time.time()), "sampled": 0, "total": 0, "points": []}
    store = _store(server)
    try:
        credential = await asyncio.to_thread(require_credential, store, _uid(user))
        return await asyncio.to_thread(
            query_cluster_trend,
            credential,
            targets=targets,
            minutes=body.minutes,
            period=body.period,
            max_instances=body.max_instances,
        )
    except CloudError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - SDK errors vary
        raise HTTPException(status_code=502, detail=f"集群趋势查询失败: {exc}") from exc


@router.post("/action")
async def action(
    body: ActionBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    store = _store(server)
    try:
        credential = await asyncio.to_thread(require_credential, store, _uid(user))
        return await asyncio.to_thread(
            instance_action,
            credential,
            region=body.region,
            instance_id=body.instance_id,
            action=body.action,
        )
    except CloudError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - SDK errors vary
        raise HTTPException(status_code=502, detail=f"操作失败: {exc}") from exc


@router.post("/import-from-tccli")
async def import_from_tccli(
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    """One-click import of this machine's existing tccli OAuth credential."""
    path = Path.home() / ".tccli" / "default.credential"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="本机没有 tccli 凭证，请使用一键授权")
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=422, detail=f"tccli 凭证无法读取: {exc}") from exc
    if str(raw.get("type") or "") != "oauth":
        raise HTTPException(status_code=422, detail="本机 tccli 凭证不是 OAuth 类型")

    oauth = raw.get("oauth") or {}
    credential = CloudCredential(
        secret_id=str(raw.get("secretId") or ""),
        secret_key=str(raw.get("secretKey") or ""),
        token=str(raw.get("token") or ""),
        expires_at=float(raw.get("expiresAt") or 0),
        access_token=str(oauth.get("accessToken") or ""),
        access_expires_at=float(oauth.get("expiresAt") or 0),
        refresh_token=str(oauth.get("refreshToken") or ""),
        open_id=str(oauth.get("openId") or ""),
        site=str(oauth.get("site") or "cn"),
    )
    if not credential.secret_id or not credential.secret_key:
        raise HTTPException(status_code=422, detail="tccli 凭证缺少 SecretId/SecretKey")

    try:
        if credential.remaining() <= CRED_REFRESH_SAFE_S:
            credential = await asyncio.to_thread(refresh_credential, credential)
    except CloudError as exc:
        raise HTTPException(status_code=409, detail=f"本机凭证已失效: {exc}") from exc

    _store(server).save(_uid(user), credential)
    return _status_payload(credential)
