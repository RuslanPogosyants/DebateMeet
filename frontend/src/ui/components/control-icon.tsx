export function ControlIcon({
  kind,
  off = false,
}: {
  kind:
    | 'microphone'
    | 'camera'
    | 'settings'
    | 'hand'
    | 'chat'
    | 'more'
    | 'close'
    | 'play'
    | 'pause'
    | 'reset'
    | 'share'
    | 'person'
    | 'speaker'
    | 'flag'
    | 'flag-transfer'
    | 'people'
    | 'leave-call'
    | 'pin'
    | 'screen'
  off?: boolean
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'microphone' && (
        <>
          <rect x="9" y="3" width="6" height="12" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6" />
        </>
      )}
      {kind === 'camera' && (
        <>
          <rect x="3" y="6" width="12" height="12" rx="2" />
          <path d="m15 10 6-3v10l-6-3" />
        </>
      )}
      {kind === 'settings' && (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="m10 3-.5 2-2 .9-1.8-.6-2 3.4 1.5 1.4v3.8l-1.5 1.4 2 3.4 1.8-.6 2 .9.5 2h4l.5-2 2-.9 1.8.6 2-3.4-1.5-1.4v-3.8l1.5-1.4-2-3.4-1.8.6-2-.9L14 3Z" />
        </>
      )}
      {kind === 'hand' && (
        <path d="M8 12V5a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v7-4a1.5 1.5 0 0 1 3 0v7c0 4-3 7-7 7-3 0-5-2-6-4l-3-5a1.6 1.6 0 0 1 2.7-1.7L8 13" />
      )}
      {kind === 'chat' && (
        <path d="M20 4H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4l4 3v-3h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1ZM7 9h10M7 13h6" />
      )}
      {kind === 'more' && (
        <>
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </>
      )}
      {kind === 'close' && <path d="m6 6 12 12M18 6 6 18" />}
      {kind === 'play' && <path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none" />}
      {kind === 'pause' && <path d="M8 5v14M16 5v14" strokeWidth="3" />}
      {kind === 'reset' && <path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" />}
      {kind === 'share' && <path d="M12 15V3m-4 4 4-4 4 4M6 10H4v11h16V10h-2" />}
      {kind === 'speaker' && (
        <>
          <path d="M4 9h4l5-4v14l-5-4H4Z" />
          <path d="M17 8a6 6 0 0 1 0 8M20 5a10 10 0 0 1 0 14" />
        </>
      )}
      {(kind === 'flag' || kind === 'flag-transfer') && (
        <>
          <path d="M5 21V3m0 1c4-3 8 3 13 0v8c-5 3-9-3-13 0" />
          {kind === 'flag-transfer' && <path d="M12 18h9m-3-3 3 3-3 3" />}
        </>
      )}
      {kind === 'people' && (
        <>
          <circle cx="9" cy="7" r="3" />
          <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 13a6 6 0 0 1 3 5v3" />
        </>
      )}
      {kind === 'leave-call' && (
        <path d="M3 14c5-5 13-5 18 0l-2 4-4-2v-3a16 16 0 0 0-6 0v3l-4 2Z" />
      )}
      {kind === 'pin' && <path d="m8 3 9 0-2 5 3 4v2h-6l-4 7v-7H5v-2l3-4Z" />}
      {kind === 'screen' && (
        <>
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8m-4-4v4M12 13V7m-3 3 3-3 3 3" />
        </>
      )}
      {kind === 'person' && (
        <>
          <circle cx="12" cy="7" r="4" fill="currentColor" stroke="none" />
          <path d="M3 22v-3a9 9 0 0 1 18 0v3Z" fill="currentColor" stroke="none" />
        </>
      )}
      {off && <path d="m3 3 18 18" />}
    </svg>
  )
}
