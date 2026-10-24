"""Tencent Cloud CVM access for the Workbench cloud tab.

Uses the same browser OAuth flow as ``tccli`` (the one the Cluster Doctor
expert relies on) so operators never paste long-term AK/SK pairs. Credentials
are encrypted per user under ``~/.octop/secrets/cloud/`` and refreshed
automatically while the refresh token is still valid.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import secrets
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from cryptography.fernet import Fernet
from tencentcloud.common.credential import Credential
from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
from tencentcloud.common.profile.client_profile import ClientProfile
from tencentcloud.common.profile.http_profile import HttpProfile
from tencentcloud.cvm.v20170312 import cvm_client
from tencentcloud.cvm.v20170312 import models as cvm_models
from tencentcloud.monitor.v20180724 import models as monitor_models
from tencentcloud.monitor.v20180724 import monitor_client

_AUTH_URL = "https://cloud.tencent.com/open/authorize"
_REDIRECT_URL = "https://cli.cloud.tencent.com/oauth"
_API_ENDPOINT = "https://cli.cloud.tencent.com"
_APP_ID = 100038427476
_SITE = "cn"
_LANG = "zh-CN"

_LOGGER = logging.getLogger(__name__)

STATE_TTL_S = 600.0
CRED_REFRESH_SAFE_S = 300.0
ACCESS_REFRESH_SAFE_S = 300.0

_CST = timezone(timedelta(hours=8))

_METRICS = {
    "cpu": "CpuUsage",
    "mem": "MemUsage",
    # Tencent names the load average "CpuLoadavg" (1 min); "CpuLoad" does not exist.
    "load": "CpuLoadavg",
    # Requires the cloud monitor agent; empty series when absent.
    "disk_usage": "CvmDiskUsage",
    "net_in": "LanIntraffic",
    "net_out": "LanOuttraffic",
}


class CloudError(RuntimeError):
    """Raised when a Tencent Cloud call cannot complete."""


def _post_json(path: str, body: dict[str, Any]) -> dict[str, Any]:
    payload = json.dumps(body).encode()
    request = urllib.request.Request(
        _API_ENDPOINT + path,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
            raw = response.read().decode() or "{}"
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:200]
        raise CloudError(f"HTTP {exc.code}: {detail}") from exc
    except Exception as exc:  # noqa: BLE001 - surface any transport failure
        raise CloudError(f"腾讯云 OAuth 网关不可达: {exc}") from exc

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise CloudError("腾讯云 OAuth 网关返回了无法解析的内容") from exc
    if not isinstance(parsed, dict):
        raise CloudError("腾讯云 OAuth 网关返回了意外的内容")
    if "Error" in parsed:
        raise CloudError(json.dumps(parsed["Error"], ensure_ascii=False))
    return parsed


def build_authorization(state: str) -> str:
    redirect = _REDIRECT_URL + "?" + urlencode(
        {"browser": "no", "lang": _LANG, "site": _SITE}
    )
    query = urlencode(
        {
            "scope": "login",
            "app_id": _APP_ID,
            "redirect_url": redirect,
            "state": state,
        }
    )
    return f"{_AUTH_URL}?{query}".replace("_", "%5F")


def decode_ticket(code: str) -> dict[str, Any]:
    cleaned = "".join(code.split())
    if not cleaned:
        raise CloudError("验证码为空")
    padded = cleaned + "=" * (-len(cleaned) % 4)
    try:
        payload = json.loads(base64.b64decode(padded, validate=False))
    except Exception as exc:  # noqa: BLE001 - any decode failure is user input
        raise CloudError("验证码不是有效的 base64 票据") from exc
    if not isinstance(payload, dict) or not payload.get("accessToken"):
        raise CloudError("验证码缺少 accessToken")
    return payload


def fetch_sts(access_token: str, site: str = _SITE) -> dict[str, Any]:
    payload = _post_json(
        "/get_temp_cred",
        {"TraceId": str(uuid.uuid4()), "AccessToken": access_token, "Site": site},
    )
    try:
        return {
            "secret_id": str(payload["SecretId"]),
            "secret_key": str(payload["SecretKey"]),
            "token": str(payload.get("Token") or ""),
            "expires_at": float(payload["ExpiresAt"]),
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise CloudError("临时凭证响应缺少字段") from exc


def refresh_access_token(refresh_token: str, open_id: str, site: str = _SITE) -> dict[str, Any]:
    payload = _post_json(
        "/refresh_user_token",
        {
            "TraceId": str(uuid.uuid4()),
            "RefreshToken": refresh_token,
            "OpenId": open_id,
            "Site": site,
        },
    )
    try:
        return {
            "access_token": str(payload["AccessToken"]),
            "access_expires_at": float(payload["ExpiresAt"]),
        }
    except (KeyError, TypeError, ValueError) as exc:
        raise CloudError("刷新响应缺少字段") from exc


@dataclass(frozen=True)
class CloudCredential:
    secret_id: str
    secret_key: str
    token: str
    expires_at: float
    access_token: str
    access_expires_at: float
    refresh_token: str
    open_id: str
    site: str = _SITE

    def to_dict(self) -> dict[str, Any]:
        return {
            "secret_id": self.secret_id,
            "secret_key": self.secret_key,
            "token": self.token,
            "expires_at": self.expires_at,
            "access_token": self.access_token,
            "access_expires_at": self.access_expires_at,
            "refresh_token": self.refresh_token,
            "open_id": self.open_id,
            "site": self.site,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> CloudCredential:
        return cls(
            secret_id=str(raw.get("secret_id") or ""),
            secret_key=str(raw.get("secret_key") or ""),
            token=str(raw.get("token") or ""),
            expires_at=float(raw.get("expires_at") or 0),
            access_token=str(raw.get("access_token") or ""),
            access_expires_at=float(raw.get("access_expires_at") or 0),
            refresh_token=str(raw.get("refresh_token") or ""),
            open_id=str(raw.get("open_id") or ""),
            site=str(raw.get("site") or _SITE),
        )

    def remaining(self, *, now: float | None = None) -> float:
        return self.expires_at - (time.time() if now is None else now)

    def can_refresh(self) -> bool:
        return bool(self.refresh_token and self.open_id)


def credential_from_ticket(ticket: dict[str, Any]) -> CloudCredential:
    access_token = str(ticket.get("accessToken") or "")
    site = str(ticket.get("site") or _SITE)
    sts = fetch_sts(access_token, site)
    return CloudCredential(
        secret_id=sts["secret_id"],
        secret_key=sts["secret_key"],
        token=sts["token"],
        expires_at=sts["expires_at"],
        access_token=access_token,
        access_expires_at=float(ticket.get("expiresAt") or 0),
        refresh_token=str(ticket.get("refreshToken") or ""),
        open_id=str(ticket.get("openId") or ""),
        site=site,
    )


def refresh_credential(credential: CloudCredential) -> CloudCredential:
    access_token = credential.access_token
    access_expires_at = credential.access_expires_at
    if access_expires_at - time.time() < ACCESS_REFRESH_SAFE_S:
        if not credential.can_refresh():
            raise CloudError("访问令牌已过期且无法续期，请重新授权")
        renewed = refresh_access_token(
            credential.refresh_token, credential.open_id, credential.site
        )
        access_token = renewed["access_token"]
        access_expires_at = renewed["access_expires_at"]
    sts = fetch_sts(access_token, credential.site)
    return CloudCredential(
        secret_id=sts["secret_id"],
        secret_key=sts["secret_key"],
        token=sts["token"],
        expires_at=sts["expires_at"],
        access_token=access_token,
        access_expires_at=access_expires_at,
        refresh_token=credential.refresh_token,
        open_id=credential.open_id,
        site=credential.site,
    )


class CloudCredentialStore:
    """Encrypted per-user Tencent Cloud login for the Workbench."""

    def __init__(self, root: Path) -> None:
        self._dir = root / "secrets" / "cloud"
        self._key_path = root / "secrets" / "cloud.key"

    def _fernet(self) -> Fernet:
        self._key_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not self._key_path.exists():
            self._key_path.write_bytes(Fernet.generate_key())
            os.chmod(self._key_path, 0o600)
        return Fernet(self._key_path.read_bytes().strip())

    def _path(self, user_id: int) -> Path:
        return self._dir / f"tencent-{int(user_id)}.enc"

    def _state_path(self, user_id: int) -> Path:
        return self._dir / f"state-{int(user_id)}.json"

    def load(self, user_id: int) -> CloudCredential | None:
        path = self._path(user_id)
        if not path.is_file():
            return None
        try:
            raw = json.loads(self._fernet().decrypt(path.read_bytes()))
        except Exception:  # noqa: BLE001 - corrupted blob must not crash callers
            return None
        credential = CloudCredential.from_dict(raw)
        if not credential.secret_id or not credential.secret_key:
            return None
        return credential

    def save(self, user_id: int, credential: CloudCredential) -> None:
        self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self._path(user_id)
        path.write_bytes(self._fernet().encrypt(json.dumps(credential.to_dict()).encode()))
        os.chmod(path, 0o600)

    def clear(self, user_id: int) -> bool:
        removed = False
        for path in (self._path(user_id), self._state_path(user_id)):
            try:
                path.unlink()
                removed = True
            except FileNotFoundError:
                continue
        return removed

    def new_state(self, user_id: int) -> str:
        self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        value = secrets.token_urlsafe(16)
        path = self._state_path(user_id)
        path.write_text(json.dumps({"state": value, "created_at": time.time()}))
        os.chmod(path, 0o600)
        return value

    def consume_state(self, user_id: int, state: str) -> bool | None:
        path = self._state_path(user_id)
        if not path.is_file():
            return None
        try:
            payload = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return None
        expected = str(payload.get("state") or "")
        created = float(payload.get("created_at") or 0)
        if not expected or time.time() - created > STATE_TTL_S:
            return None
        if not secrets.compare_digest(expected, state.strip()):
            return False
        path.unlink(missing_ok=True)
        return True


def require_credential(store: CloudCredentialStore, user_id: int) -> CloudCredential:
    credential = store.load(user_id)
    if credential is None:
        raise CloudError("尚未授权腾讯云")
    if credential.remaining() > CRED_REFRESH_SAFE_S:
        return credential
    renewed = refresh_credential(credential)
    store.save(user_id, renewed)
    return renewed


def _profile(timeout_seconds: int = 20) -> ClientProfile:
    http = HttpProfile()
    http.reqTimeout = timeout_seconds
    return ClientProfile(httpProfile=http)


def _credential_of(credential: CloudCredential) -> Credential:
    return Credential(credential.secret_id, credential.secret_key, credential.token)


def list_regions(credential: CloudCredential) -> list[dict[str, str]]:
    client = cvm_client.CvmClient(_credential_of(credential), "ap-guangzhou", _profile())
    response = client.DescribeRegions(cvm_models.DescribeRegionsRequest())
    return [
        {"id": str(item.Region), "name": str(item.RegionName or item.Region)}
        for item in (response.RegionSet or [])
        if item.Region and str(item.RegionState or "") != "UNAVAILABLE"
    ]


def list_instances(
    credential: CloudCredential,
    regions: list[str],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for region in regions:
        client = cvm_client.CvmClient(_credential_of(credential), region, _profile())
        offset = 0
        while True:
            request = cvm_models.DescribeInstancesRequest()
            request.Offset = offset
            request.Limit = 100
            response = client.DescribeInstances(request)
            batch = list(response.InstanceSet or [])
            for item in batch:
                if not item.InstanceId:
                    continue
                public_ips = [str(ip) for ip in (item.PublicIpAddresses or [])]
                private_ips = [str(ip) for ip in (item.PrivateIpAddresses or [])]
                out.append(
                    {
                        "instance_id": str(item.InstanceId),
                        "name": str(item.InstanceName or item.InstanceId),
                        "region": region,
                        "zone": str(item.Placement.Zone if item.Placement else ""),
                        "state": str(item.InstanceState or ""),
                        "os_name": str(item.OsName or ""),
                        "private_ips": private_ips,
                        "public_ips": public_ips,
                        "created_at": str(item.CreatedTime or ""),
                        "cpu": int(item.CPU or 0),
                        "memory_gb": int(item.Memory or 0),
                    }
                )
            offset += len(batch)
            if not batch or offset >= int(response.TotalCount or 0):
                break
    return out


def _time_window(minutes: int) -> tuple[str, str]:
    end = datetime.now(_CST)
    start = end - timedelta(minutes=minutes)
    return (
        start.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        end.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
    )


def query_metrics(
    credential: CloudCredential,
    *,
    region: str,
    instance_id: str,
    minutes: int = 60,
    period: int = 60,
) -> dict[str, Any]:
    """Return CloudMonitor series for one instance (CPU / memory / load)."""
    client = monitor_client.MonitorClient(
        _credential_of(credential), region, _profile()
    )
    start, end = _time_window(minutes)
    series: dict[str, Any] = {}
    for key, metric in _METRICS.items():
        request = monitor_models.GetMonitorDataRequest()
        request.Namespace = "QCE/CVM"
        request.MetricName = metric
        request.Period = period
        request.StartTime = start
        request.EndTime = end
        request.Instances = [
            {"Dimensions": [{"Name": "InstanceId", "Value": instance_id}]}
        ]
        try:
            response = client.GetMonitorData(request)
        except TencentCloudSDKException as exc:
            # A wrong metric name used to fail silently and render as "no data".
            _LOGGER.warning("cloud metric %s (%s) failed: %s", key, metric, exc)
            series[key] = []
            continue
        points = list(response.DataPoints or [])
        if not points:
            series[key] = []
            continue
        first = points[0]
        series[key] = [
            {"t": int(ts), "v": float(value)}
            for ts, value in zip(first.Timestamps or [], first.Values or [])
        ]
    return {"instance_id": instance_id, "region": region, "series": series}


BATCH_INSTANCE_LIMIT = 100


def query_latest_metrics(
    credential: CloudCredential,
    *,
    targets: list[dict[str, str]],
    period: int = 60,
) -> dict[str, Any]:
    """Latest value per instance for every metric, batched across instances.

    ``GetMonitorData`` accepts many instance dimensions per call, so a 500 node
    fleet costs a handful of requests instead of one per instance.
    """
    sampled_at = int(time.time())
    if not targets:
        return {"sampled_at": sampled_at, "items": {}}

    # 只需要最新值：60s 粒度下取 6 分钟窗口即可覆盖 CloudMonitor 的 1~2 分钟延迟，
    # 窗口再大只会让每次批量响应多传几倍数据点。
    start, end = _time_window(6)
    clients: dict[str, Any] = {}
    items: dict[str, dict[str, float]] = {}

    for key, metric in _METRICS.items():
        buckets: dict[str, list[str]] = {}
        for target in targets:
            region = target.get("region") or ""
            instance_id = target.get("instance_id") or ""
            if not region or not instance_id:
                continue
            buckets.setdefault(region, []).append(instance_id)
        for region, instance_ids in buckets.items():
            client = clients.get(region)
            if client is None:
                client = monitor_client.MonitorClient(
                    _credential_of(credential), region, _profile()
                )
                clients[region] = client
            for offset in range(0, len(instance_ids), BATCH_INSTANCE_LIMIT):
                chunk = instance_ids[offset : offset + BATCH_INSTANCE_LIMIT]
                request = monitor_models.GetMonitorDataRequest()
                request.Namespace = "QCE/CVM"
                request.MetricName = metric
                request.Period = period
                request.StartTime = start
                request.EndTime = end
                request.Instances = [
                    {"Dimensions": [{"Name": "InstanceId", "Value": instance_id}]}
                    for instance_id in chunk
                ]
                try:
                    response = client.GetMonitorData(request)
                except TencentCloudSDKException as exc:
                    _LOGGER.warning(
                        "cloud batch metric %s (%s) failed: %s", key, metric, exc
                    )
                    continue
                for points in response.DataPoints or []:
                    instance_id = ""
                    for dimension in points.Dimensions or []:
                        if dimension.Name == "InstanceId":
                            instance_id = dimension.Value or ""
                            break
                    if not instance_id:
                        continue
                    values = [v for v in (points.Values or []) if v is not None]
                    if not values:
                        continue
                    items.setdefault(instance_id, {})[key] = float(values[-1])
    return {"sampled_at": sampled_at, "items": items}


CLUSTER_TREND_LIMIT = 12
TREND_KEYS = ("cpu", "mem", "net_in", "net_out")


def _sample_targets(
    targets: list[dict[str, str]], limit: int
) -> list[dict[str, str]]:
    """Round-robin across regions so one big region cannot dominate the sample."""
    by_region: dict[str, list[dict[str, str]]] = {}
    for target in targets:
        region = (target.get("region") or "").strip()
        instance_id = (target.get("instance_id") or "").strip()
        if region and instance_id:
            by_region.setdefault(region, []).append(
                {"region": region, "instance_id": instance_id}
            )

    picked: list[dict[str, str]] = []
    depth = 0
    while len(picked) < limit:
        added = False
        for bucket in by_region.values():
            if len(picked) >= limit:
                break
            if depth < len(bucket):
                picked.append(bucket[depth])
                added = True
        if not added:
            break
        depth += 1
    return picked


def query_cluster_trend(
    credential: CloudCredential,
    *,
    targets: list[dict[str, str]],
    minutes: int = 60,
    period: int = 60,
    max_instances: int = CLUSTER_TREND_LIMIT,
) -> dict[str, Any]:
    """Average CPU / memory / network over time across a sampled subset.

    ``GetMonitorData`` caps a response at roughly 1440 points and the fleet is
    large, so the trend samples a round-robin subset of instances and averages
    them per timestamp. The payload reports how many instances were sampled so
    the UI can label the curve honestly instead of pretending it covers all
    nodes.
    """
    sampled_at = int(time.time())
    picked = _sample_targets(targets, max(1, max_instances))
    if not picked:
        return {"sampled_at": sampled_at, "sampled": 0, "total": 0, "points": []}

    start, end = _time_window(minutes)
    clients: dict[str, Any] = {}
    buckets: dict[int, dict[str, list[float]]] = {}

    for key in TREND_KEYS:
        metric = _METRICS[key]
        by_region: dict[str, list[str]] = {}
        for target in picked:
            by_region.setdefault(target["region"], []).append(target["instance_id"])
        for region, instance_ids in by_region.items():
            client = clients.get(region)
            if client is None:
                client = monitor_client.MonitorClient(
                    _credential_of(credential), region, _profile()
                )
                clients[region] = client
            for offset in range(0, len(instance_ids), BATCH_INSTANCE_LIMIT):
                chunk = instance_ids[offset : offset + BATCH_INSTANCE_LIMIT]
                request = monitor_models.GetMonitorDataRequest()
                request.Namespace = "QCE/CVM"
                request.MetricName = metric
                request.Period = period
                request.StartTime = start
                request.EndTime = end
                request.Instances = [
                    {"Dimensions": [{"Name": "InstanceId", "Value": instance_id}]}
                    for instance_id in chunk
                ]
                try:
                    response = client.GetMonitorData(request)
                except TencentCloudSDKException as exc:
                    _LOGGER.warning("cluster trend %s failed: %s", metric, exc)
                    continue
                for points in response.DataPoints or []:
                    for stamp, value in zip(
                        points.Timestamps or [], points.Values or []
                    ):
                        if value is None:
                            continue
                        # Align to the period so instances reporting with a
                        # one-second skew still land in the same bucket.
                        bucket = int(float(stamp))
                        bucket -= bucket % max(1, period)
                        buckets.setdefault(bucket, {}).setdefault(key, []).append(
                            float(value)
                        )

    points: list[dict[str, Any]] = []
    for stamp in sorted(buckets):
        row: dict[str, Any] = {"t": stamp}
        for key in TREND_KEYS:
            values = buckets[stamp].get(key) or []
            if values:
                row[key] = round(sum(values) / len(values), 2)
        points.append(row)

    return {
        "sampled_at": sampled_at,
        "sampled": len(picked),
        "total": len(targets),
        "period": period,
        "points": points,
    }


_ACTIONS = {
    "start": (cvm_models.StartInstancesRequest, "StartInstances"),
    "stop": (cvm_models.StopInstancesRequest, "StopInstances"),
    "reboot": (cvm_models.RebootInstancesRequest, "RebootInstances"),
}


def instance_action(
    credential: CloudCredential,
    *,
    region: str,
    instance_id: str,
    action: str,
) -> dict[str, Any]:
    spec = _ACTIONS.get(action)
    if spec is None:
        raise CloudError(f"不支持的操作: {action}")
    request_cls, _name = spec
    client = cvm_client.CvmClient(_credential_of(credential), region, _profile())
    request = request_cls()
    request.InstanceIds = [instance_id]
    if action == "stop":
        request.StoppedMode = "STOP_CHARGING"
    client.call(_name, request.to_json_string())
    return {"instance_id": instance_id, "action": action, "accepted": True}
