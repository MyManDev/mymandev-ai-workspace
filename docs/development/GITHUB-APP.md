# Development GitHub App

Sign-in with GitHub uses a GitHub App ([ADR 0014](../architecture/decisions/0014-accounts-devices-and-invitations.md), P-49). The production and staging apps belong to the MyManDev organization and are operated by the Project Manager. Every contributor who works on sign-in registers their own development app, so that no secret is shared and nobody needs access to the production app.

The steps below match GitHub's settings pages as of October 2026. GitHub renames fields from time to time; the names in brackets are the ones in use when these steps were written.

## Register the app

1. On GitHub, open your profile picture, then **Settings**, **Developer settings**, **GitHub Apps**, and **New GitHub App**. Register it on your personal account, not on the organization.
2. Fill in the form:

   | Field                                                  | Value                                                                                                                       |
   | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
   | GitHub App name                                        | `MyManDev Dev <your GitHub login>`, at most 34 characters. Never plain `MyManDev`: that name belongs to the production app. |
   | Homepage URL                                           | `https://mymandev.com`                                                                                                      |
   | Callback URL [Redirect URI]                            | `http://127.0.0.1:3000/auth/github/callback`, with wildcard matching off                                                    |
   | Expire user authorization tokens                       | On                                                                                                                          |
   | Request user authorization (OAuth) during installation | Off                                                                                                                         |
   | Enable Device Flow                                     | Off                                                                                                                         |
   | Setup URL, Redirect on update                          | Empty, off                                                                                                                  |
   | Webhook: Active                                        | On, to test the revocation event. You may leave it off if you do not need the webhook.                                      |
   | Webhook URL                                            | A relay to your machine, for example a channel from [smee.io](https://smee.io)                                              |
   | Webhook secret                                         | 32 random bytes as hex, for example from `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`         |
   | SSL verification                                       | Enabled                                                                                                                     |
   | Permissions (repository, organization, account)        | All **No access**, including the email addresses permission                                                                 |
   | Subscribe to events                                    | None. The revocation event `github_app_authorization` arrives without a subscription.                                       |
   | Where can this GitHub App be installed?                | **Any account**. A private app can be authorized only within the account that owns it.                                      |

3. Select **Create GitHub App**.
4. On the **Credentials** page of the app, generate a client secret under **Client secrets** and copy it at once; GitHub shows it only once. Do not generate a private key: sign-in does not use one.
5. If the expiration setting was not offered in the form, check **Optional features**: user-to-server token expiration must stay on.
6. On **Advanced**, the **Danger zone** shows **Make private** for a public app. If it shows **Make public**, the app is private: make it public.

## Keep the secrets outside the repository

The client secret and the webhook secret never enter the repository, an issue, a pull request, or a chat. Until the API reads them from its own ignored `.env` file, keep them in `~/.mymandev/github-dev-app.env` (on Windows, `%USERPROFILE%\.mymandev\github-dev-app.env`), readable only by you:

```sh
API_GITHUB_CLIENT_ID=...
API_GITHUB_CLIENT_SECRET=...
API_GITHUB_WEBHOOK_SECRET=...
GITHUB_DEV_APP_SMEE_URL=https://smee.io/...
```

The client ID is not secret. If a secret leaks, generate a new client secret on **Credentials** and delete the old one, or set a new webhook secret on **General**. To remove the app, use **Advanced**, **Delete GitHub App**.

## Test the webhook locally

GitHub cannot reach `127.0.0.1`, so a relay forwards each delivery to your machine: [smee.io](https://smee.io) holds a channel open to a client on your machine, which posts every delivery to the local API.

1. On smee.io, select **Start a new channel**. Use the channel URL as the **Webhook URL** of your development app (**General**, **Webhook**), keep **Active** on, and keep the URL in `~/.mymandev/github-dev-app.env` as `GITHUB_DEV_APP_SMEE_URL`. Anyone who knows the channel URL can read the deliveries, so do not share it.
2. In `apps/api/.env`, set `API_GITHUB_WEBHOOK_SECRET` to the webhook secret of the app, next to `DATABASE_URL` and the sign-in variables. The API accepts 32 to 256 printable ASCII characters without whitespace, so the 64 hexadecimal characters from the table above fit. Start the API with `npm run dev -w @mymandev/api`. Without the secret or the database, the webhook answers `404`.
3. Run the smee client with the channel URL as the source and the API's webhook as the target:

   ```sh
   smee --url https://smee.io/<channel> --target http://127.0.0.1:3000/auth/github/webhook
   ```

   The client is the `smee-client` npm package. It is not a dependency of this repository; install a release that is at least 14 days old, as for dependencies ([WORKSPACE.md](WORKSPACE.md)). Use `127.0.0.1`, not `localhost`: the API listens on `127.0.0.1` by default, and `localhost` may resolve to `::1`.

4. GitHub sends a GitHub App's deliveries as `application/json`, the only content type the API accepts, and the relay must keep it. The signature covers the exact bytes of the body: if every relayed delivery answers `401` although the secrets match, the relay changed the body.
5. Revoke the app's authorization under **Settings**, **Applications**, **Authorized GitHub Apps**. The event arrives about a minute later (#67), and the API answers `204`. When your GitHub account has an account in the local database, the API logs `"githubEvent":"github_app_authorization"` with `"outcome":"revoked"`, closes the account's sockets with `sign_in_required`, and every device of the account must sign in again; otherwise it logs `no_account`.
6. To send an event again, open **Advanced** in the app's settings, choose the delivery under **Recent Deliveries**, and select **Redeliver**. A redelivery keeps the delivery ID, so the API answers `204`, changes nothing, and logs `already_processed`.

Never put the webhook secret or the channel URL into the repository, an issue, or a pull request. [`apps/api/README.md`](../../apps/api/README.md#post-authgithubwebhook) describes the route.

## What to expect

These results come from the checks in #67:

- The consent screen names the app and the account that owns it, and asks only to verify your identity.
- A person who has already authorized the app passes GitHub without a prompt; `prompt=select_account` shows an account chooser.
- User access tokens expire after 8 hours, and refresh tokens after about six months.
- Revoking the authorization under **Settings**, **Applications**, **Authorized GitHub Apps** sends `github_app_authorization` with action `revoked`, also when the app was never installed.
