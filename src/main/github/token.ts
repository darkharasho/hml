import type { AppPaths } from '../store/paths'
import { noSecureStorage } from '../../shared/messages'
import { loadSecret, saveSecret, type SecretPort } from '../secrets'

export type { SecretPort }

export function loadToken(paths: AppPaths, secrets: SecretPort): Promise<string | null> {
  return loadSecret(paths.ghToken, secrets)
}

export const NO_SECURE_STORAGE = noSecureStorage('a GitHub token')

export function saveToken(
  paths: AppPaths,
  secrets: SecretPort,
  token: string | null
): Promise<void> {
  return saveSecret(paths.ghToken, secrets, token, 'a GitHub token')
}
