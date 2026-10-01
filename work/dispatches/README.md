# Worker dispatch artefacts live under work/dispatches/, NOT in the repository root.
#
# This file was added because reading the root told a confusing story: TASK-SESSION-BOUNDARY-01.md and
# friends sat beside README.md, server.js and package.json as if they were application files. They are
# the coordinator's briefs to workers - a record of what was ASKED, kept because it is useful when
# reviewing what was delivered, but they are not the app, they are not the site, and a bare
# `DISPATCH.md` name in the root is indistinguishable from something that matters. They were committed
# because the coordinator's own dispatch template told workers to "open the working record" with those
# names, so the process put them there rather than anyone choosing to.
#
# Moved, not deleted: work/dispatches/ preserves them.