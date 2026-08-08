const AVATAR_COLORS = [
  'linear-gradient(135deg,#A84B27,#6A2D15)',
  'linear-gradient(135deg,#186B5A,#0D4438)',
  'linear-gradient(135deg,#A33558,#8A3A15)',
  'linear-gradient(135deg,#2B68C2,#163D7A)',
  'linear-gradient(135deg,#8C5003,#5A3400)',
  'linear-gradient(135deg,#7C5A3A,#5A3E25)',
]

export function getAvatarColor(name) {
  if (!name) return AVATAR_COLORS[0]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (name.charCodeAt(i) + ((hash << 5) - hash)) | 0
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

export function getInitials(name) {
  if (!name) return 'F'
  const parts = name.trim().split(/\s+/)
  return parts.length === 1 ? parts[0].slice(0, 2).toUpperCase() : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
