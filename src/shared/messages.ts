/** How GitHub's rate-limit error starts; main builds it, the renderer recognises it. */
export const GH_RATE_LIMIT_PREFIX = "GitHub's rate limit was reached"
/** How the error for a token GitHub rejected starts. */
export const GH_REJECTED_TOKEN_PREFIX = 'GitHub rejected the saved token'

/** True for GitHub's rate-limit and rejected-token errors (messages, not other failures). */
export function isGhAccessError(message: string): boolean {
  return message.startsWith(GH_RATE_LIMIT_PREFIX) || message.startsWith(GH_REJECTED_TOKEN_PREFIX)
}
