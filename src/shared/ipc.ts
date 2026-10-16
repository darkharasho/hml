export interface HmlApi {
  ping(): Promise<'pong'>
}

export const HML_METHODS: (keyof HmlApi)[] = ['ping']

export function channel(method: keyof HmlApi): string {
  return `hml:${method}`
}
