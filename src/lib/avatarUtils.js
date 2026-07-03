const AVATAR_COLORS = [
  'linear-gradient(135deg,#8B7CFF,#5B45F0)',
  'linear-gradient(135deg,#2FD4B6,#20A896)',
  'linear-gradient(135deg,#FF6B8A,#F5A623)',
  'linear-gradient(135deg,#4DA3FF,#2D7BE0)',
  'linear-gradient(135deg,#F5A623,#E8872A)',
  'linear-gradient(135deg,#C77DFF,#9B4FE0)',
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
