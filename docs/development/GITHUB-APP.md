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

## What to expect

These results come from the checks in #67:

- The consent screen names the app and the account that owns it, and asks only to verify your identity.
- A person who has already authorized the app passes GitHub without a prompt; `prompt=select_account` shows an account chooser.
- User access tokens expire after 8 hours, and refresh tokens after about six months.
- Revoking the authorization under **Settings**, **Applications**, **Authorized GitHub Apps** sends `github_app_authorization` with action `revoked`, also when the app was never installed.
