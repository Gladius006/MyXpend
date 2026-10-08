# Deploy MyXpend on Railway

MyXpend uses SQLite, so the deployed service must have a persistent volume. Without a volume, registered users and transactions disappear when the service restarts or redeploys.

## 1. Put the project on GitHub

Create a repository named `myxpend`, then push the contents of this folder. The `Dockerfile` must be at the repository root.

```powershell
git init
git add .
git commit -m "Build auditable MyXpend finance tracker"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/myxpend.git
git push -u origin main
```

## 2. Create the Railway service

1. Sign in to Railway and choose **New Project**.
2. Select **Deploy from GitHub repo** and choose the `myxpend` repository.
3. Railway will detect the root `Dockerfile` automatically.
4. Open the service's **Settings** and set the health-check path to `/api/health`.

The application already listens on Railway's injected `PORT` value.

## 3. Attach persistent storage

1. On the project canvas, create a **Volume** and attach it to the MyXpend service.
2. Set its mount path to `/data`.
3. Redeploy the service.

Railway automatically supplies `RAILWAY_VOLUME_MOUNT_PATH=/data`. MyXpend detects it and stores SQLite at `/data/myxpend.db`; no additional database variable is required.

## 4. Generate the public URL

Open the service's **Settings**, find **Networking**, and choose **Generate Domain**. Open the generated HTTPS address and create a new account.

Verify the health endpoint at:

```text
https://YOUR_DOMAIN/api/health
```

It should return:

```json
{"status":"ok"}
```

## 5. Enable the owner admin dashboard

1. Create your owner account on the live site first.
2. Open the MyXpend service's **Variables** tab in Railway.
3. Add `MYXPEND_ADMIN_EMAIL` with the exact email of that existing account. Keep this deployment setting out of public source code.
4. Deploy the variable change, then sign in to MyXpend and select **Admin**.

Only this account receives read-only access to the user directory, financial records, graphs, and JSON exports. Passwords and session credentials are never exposed. No admin access is enabled without the setting. An email that does not already exist prevents startup, so verify the account before changing the variable. Remove the variable and redeploy to revoke admin access.

## Deployment checks

- Register a test user.
- Add money and one expense.
- Confirm the displayed balance changes correctly.
- Redeploy the same commit and confirm the test user can still sign in. This proves the volume is mounted correctly.
- Download a CSV export and store periodic backups outside Railway.

## Important limitation

SQLite supports this portfolio deployment well as a single service instance. Do not enable multiple replicas against the same SQLite file. Move to PostgreSQL before horizontal scaling or heavier concurrent use.
