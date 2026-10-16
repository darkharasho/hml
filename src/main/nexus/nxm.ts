/** A parsed `nxm://` download link (parsing arrives with the protocol handler). */
export interface NxmLink {
  domain: string
  modId: number
  fileId: number
  key: string
  expires: number
  userId: number | null
}
