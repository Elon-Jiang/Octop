# Octop #2623 browser verification

Screenshots use the real production FilePreview component mounted in an isolated local fixture, with the current sandbox unchanged. They are not a screenshot of a deployed Octop instance.

- Original develop 44c22434: a fragment click loads the simulated dashboard shell in the frame.
- Fixed component: the summary target remains in the frame and scrolls into view. Parent DOM access still throws.

No live provider, user data, or credentials are included. Evidence-only branch; these files are not part of the code PR diff.
