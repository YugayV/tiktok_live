// Converts raw tiktok-live-connector payloads (proto v2 or v3 field names)
// into one stable event shape used by the rest of the app:
//   { id, type, ts, user, ...typeSpecificFields }

let seq = 0;
const nextId = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

function firstUrl(img) {
  if (!img) return '';
  const list = img.urlList || img.url || img.url_list || [];
  return Array.isArray(list) ? list[0] || '' : String(list);
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeUser(raw, identity) {
  if (!raw) return { id: '', uniqueId: 'anonymous', nickname: 'Аноним', avatar: '' };
  const ident = identity || raw.userIdentity || {};
  return {
    id: String(raw.userId || raw.id || raw.uniqueId || raw.displayId || ''),
    uniqueId: raw.uniqueId || raw.displayId || raw.username || String(raw.userId || raw.id || 'user'),
    nickname: raw.nickname || raw.nickName || raw.uniqueId || raw.displayId || 'user',
    avatar: firstUrl(raw.profilePicture || raw.avatarThumb || raw.avatarMedium) || raw.avatar || '',
    isModerator: Boolean(ident.isModeratorOfAnchor || raw.isModerator),
    isSubscriber: Boolean(ident.isSubscriberOfAnchor || raw.isSubscriber),
    isFollower: Boolean(ident.isFollowerOfAnchor || ident.isMutualFollowingWithAnchor || raw.isFollower),
  };
}

export function normalize(type, data = {}) {
  const base = { id: nextId(), type, ts: Date.now(), user: normalizeUser(data.user, data.userIdentity) };
  switch (type) {
    case 'chat':
      return { ...base, text: String(data.comment ?? data.content ?? data.text ?? '') };
    case 'gift': {
      const g = data.giftDetails || data.gift || data.extendedGiftInfo || {};
      const ext = data.extendedGiftInfo || {};
      const giftType = num(g.giftType ?? g.type ?? ext.type);
      const count = Math.max(1, num(data.repeatCount, 1));
      const diamonds = num(g.diamondCount ?? ext.diamond_count ?? data.diamondCount);
      return {
        ...base,
        giftId: String(data.giftId ?? g.id ?? ''),
        giftName: g.giftName || g.name || ext.name || data.giftName || `Gift #${data.giftId ?? '?'}`,
        giftImage: firstUrl(g.giftImage || g.image || g.icon) || ext.image?.url_list?.[0] || data.giftImage || '',
        diamonds,
        count,
        totalDiamonds: diamonds * count,
        // Streakable gifts (type 1) fire repeatedly; only the final event counts.
        streaking: giftType === 1 && !data.repeatEnd,
        groupId: String(data.groupId ?? ''),
      };
    }
    case 'like':
      return {
        ...base,
        likes: Math.max(1, num(data.likeCount ?? data.count, 1)),
        totalLikes: num(data.totalLikeCount ?? data.total),
      };
    case 'follow':
    case 'share':
    case 'member':
    case 'subscribe':
      return { ...base, viewers: num(data.memberCount) || undefined };
    case 'roomUser':
      return { ...base, viewers: num(data.viewerCount ?? data.total) };
    case 'question':
      return {
        ...base,
        user: normalizeUser(data.details?.user || data.user),
        text: data.details?.questionText || data.questionText || '',
      };
    case 'envelope': {
      const e = data.envelopeInfo || {};
      return { ...base, diamonds: num(e.diamondCount), text: e.sendUserName || '' };
    }
    default:
      return { ...base, raw: data };
  }
}
