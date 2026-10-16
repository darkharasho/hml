import { useState } from 'react'
import type { GameSummary } from '../../../shared/ipc'
import { initials } from '../tsView'

/** Cover art with an initials fallback when the icon is missing or fails to load. */
export function GameCover({
  game,
  className = ''
}: {
  game: Pick<GameSummary, 'iconUrl' | 'displayName' | 'supported'>
  className?: string
}): React.JSX.Element {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const dim = game.supported ? '' : 'grayscale-[0.7] opacity-70'
  if (game.iconUrl && failedUrl !== game.iconUrl) {
    return (
      <img
        src={game.iconUrl}
        alt=""
        loading="lazy"
        draggable={false}
        onError={() => setFailedUrl(game.iconUrl)}
        className={`size-full object-cover ${dim} ${className}`}
      />
    )
  }
  return (
    <span
      className={`grid size-full place-items-center bg-[linear-gradient(160deg,#1f3a43,#132329)] text-3xl font-bold tracking-tight text-muted ${dim} ${className}`}
    >
      {initials(game.displayName)}
    </span>
  )
}
