import type { GameSummary } from '../../../shared/ipc'
import { initials } from '../tsView'
import { useFallbackSrc } from '../useFallbackSrc'

/** Cover art, trying each fallback URL in turn, with initials when none loads. */
export function GameCover({
  game,
  className = ''
}: {
  game: Pick<GameSummary, 'iconUrl' | 'iconFallbacks' | 'displayName' | 'supported'>
  className?: string
}): React.JSX.Element {
  const { src, onError } = useFallbackSrc([game.iconUrl, ...(game.iconFallbacks ?? [])])
  const dim = game.supported ? '' : 'grayscale-[0.7] opacity-70'
  if (src) {
    return (
      <img
        key={src}
        src={src}
        alt=""
        loading="lazy"
        draggable={false}
        onError={onError}
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
