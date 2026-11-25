/** How GitHub's rate-limit error starts; main builds it, the renderer recognises it. */
export const GH_RATE_LIMIT_PREFIX = "GitHub's rate limit was reached"
/** How the error for a token GitHub rejected starts. */
export const GH_REJECTED_TOKEN_PREFIX = 'GitHub rejected the saved token'

/** Shown when a Nexus Mods download is attempted without a saved API key. */
export const NX_NO_KEY = 'Add your Nexus Mods API key in Settings to download.'

export const NX_SSO_CANCELLED = 'Nexus Mods sign-in was cancelled.'
export const NX_SSO_TIMED_OUT = 'Nexus Mods sign-in timed out. Click Sign in to try again.'
export const NX_SSO_FAILED = "HML couldn't reach Nexus Mods to sign in. Try again."

/** The message for a secret HML can't store; `what` completes it ("a GitHub token"). */
export const noSecureStorage = (what: string): string =>
  `Secure storage isn't available on this system, so HML can't save ${what}.`

/** True for GitHub's rate-limit and rejected-token errors (messages, not other failures). */
export function isGhAccessError(message: string): boolean {
  return message.startsWith(GH_RATE_LIMIT_PREFIX) || message.startsWith(GH_REJECTED_TOKEN_PREFIX)
}

export const NX_FILE_GONE = 'That file is no longer on Nexus Mods.'
