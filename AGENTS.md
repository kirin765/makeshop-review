<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:vps-ops-deployment -->
## VPS deployment

- Production uses a standalone Next.js runtime managed by `/home/giwan/Projects/vps-ops`. Read that project's `README.md` and current server inventory before deployment.
- For source-based apps, use `/opt/vps-ops/ops.py prepare APP` with an explicit file manifest, then `activate ID`; use `rollback ID` for recovery. Imweb uses `prepare-artifact` instead.
- Do not build or install dependencies inside the serving directory. Full build dependencies are archived separately; deployment preparation restores them to an isolated directory and verifies package/lockfile fingerprints.
- Preserve the existing environment files and persistent data paths. Keep the standalone public/static assets and service memory limits when updating a deployment.
<!-- END:vps-ops-deployment -->
