# Account and devices

You sign in to MyManDev with your GitHub account. Each computer where you sign in becomes a device of your account. Everything on this page happens on the "Account" screen. Its part "This device" is about this computer, and its part "Devices" lists every device of your account.

## Keep your GitHub account safe

MyManDev has no password of its own: whoever can sign in to your GitHub account can use your MyManDev account. Turn on two-factor authentication for that GitHub account in GitHub's settings. The "Account" screen recommends it too, below the sign-in buttons.

## Sign in with GitHub

1. Choose "Sign in with GitHub". The button is on the "Account" screen, and also on the "Home" screen while this device is not signed in.
2. Your browser opens, and the application shows a pairing code of 6 digits.
3. Sign in to GitHub in the browser, if you are not signed in there yet.
4. The browser shows the page "Confirm sign-in to MyManDev", with your GitHub login and a code. Choose "Continue" only if the code is the same as the one in the application, and you started this sign-in yourself. Otherwise choose "Cancel".
5. The browser hands the sign-in back to the application. If it does not do this on its own, choose "Return to MyManDev" in the browser.

The application then says which GitHub login this device is signed in to. Check it. If it is not your account, choose "This is not me" (see below).

Finish the sign-in within 10 minutes, or start it again. To stop a sign-in, choose "Cancel" in the application.

### Use another browser

Your default browser may be signed in to another GitHub account. Then choose "Use another browser" instead. You can also choose it while a sign-in waits in the browser that opened.

The application does not open a browser. It shows the sign-in address instead. Choose "Select the address", copy it (Ctrl+C, or Command+C on a Mac), and open it in the browser that you want to sign in with. Then continue as above, and check the pairing code.

Do not share this address with anyone. While the sign-in is open, someone who has the address could sign this device in to their account.

If your browser does not open after "Sign in with GitHub", the application shows the address in the same way.

## This is not me

After a sign-in, the "This device" part shows the GitHub login of this device. If it is not your account, for example because the browser was signed in to someone else's GitHub account, choose "This is not me".

The application asks first, with "Remove from this installation" and "Keep". "Remove from this installation" removes the device from that GitHub account on the server, when it can. Then it deletes the device's key and the account on this computer. After that, you can sign in with your own GitHub account.

## Renew the sign-in

A sign-in lasts 30 days. "Signed in until" shows when it ends.

- You can choose "Renew the sign-in" at any time. It is a new GitHub sign-in in the browser, with the same pairing code check. Sign in with the same GitHub account as before.
- From 6 days before the end, the screen asks you to renew the sign-in.
- If a renewal uses another GitHub account, it is refused, and this device stays signed in to its own account.
- After the end, the server asks for a new sign-in, and the screen offers "Sign in with GitHub" again.

## Sign out and remove this device

- "Sign out" signs this device out. The device stays in your account. To use it again, sign in with the same GitHub account.
- "Remove this device" removes this device from your account and deletes its key on this computer. The application asks first. To use this computer again, sign in, and it becomes a new device.

This computer holds one account at a time. To sign in here with another GitHub account, first remove this device, or choose "This is not me".

## The devices of your account

The "Devices" part lists the devices of your account. Active devices come first, under "Active devices". Revoked devices follow under "Revoked devices".

Each device shows its name, its platform, when it was created, when it was last seen, when it last signed in, and when its sign-in expires. This computer is marked "This device". A device created in the last 7 days is marked "New".

An account can have at most 20 active devices.

### Remove or revoke another device

Each other active device has two actions. The application asks before each one.

- "Remove" revokes a device that you no longer use. It can no longer connect.
- "Revoke as lost" revokes a device that was lost or stolen. It can no longer connect, and it also starts the registration lock (below).

To remove this computer, use "Remove this device" in the "This device" part.

After "Revoke as lost", the screen shows "After a lost device":

- End that device's GitHub sessions: open github.com/settings/sessions in your browser and revoke them.
- If the device was unlocked, change your GitHub password.
- Rotate the AI provider credentials that are stored on that device. The server cannot reach them.

"Dismiss the advice" hides it.

### The registration lock

After a device is revoked as lost, no new device can register on your account for 7 days. Your other devices keep working, and they can still renew their sign-in.

While the lock is in force, the "Devices" part says until when, and offers "Lift the registration lock". Lift it only when you are about to sign in on a new device yourself.

### New-device notices

When a new device registers on your account, your other devices show a notice under "Devices": "A new device was registered on this account", with its name, its platform, and when.

- If it was you, choose "Dismiss the notices".
- If it was not you, choose "This was not me: revoke as lost". This revokes that device as lost and starts the registration lock. Then follow the advice after a lost device.
