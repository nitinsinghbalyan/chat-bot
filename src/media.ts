/**
 * Media the bot can share in chat as cards (product cards, photos, videos, PDF documents).
 * Cards are built on the server from the seller's KB and crawled pages only, never from model
 * text, so the bot cannot invent a link or an image.
 */

export type MediaKind = "product" | "image" | "video" | "document";

export interface MediaCard {
  type: MediaKind;
  title: string;
  /** Where the card opens: product page, full image, video page or PDF. */
  url: string;
  /** Thumbnail image (product photo, the image itself, or a video thumbnail). */
  thumb?: string | null;
  /** Embeddable player URL for videos that support it (YouTube, Vimeo, MP4). */
  embed?: string | null;
  /** Short second line, e.g. the product's category. */
  subtitle?: string;
}

export function httpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** YouTube video id from watch, youtu.be, embed and shorts URLs. */
export function youtubeId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|v|live)\/([^/?#]+)/);
      id = m?.[1] ?? null;
    }
  }
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
}

/** Recognises a playable video link and works out its thumbnail and embed URL. */
export function videoInfo(url: string, thumbnail?: string | null): { url: string; thumb: string | null; embed: string | null } | null {
  const href = httpUrl(url);
  if (!href) return null;
  const yt = youtubeId(href);
  if (yt) return { url: `https://www.youtube.com/watch?v=${yt}`, thumb: httpUrl(thumbnail) ?? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, embed: `https://www.youtube-nocookie.com/embed/${yt}?autoplay=1` };
  const u = new URL(href);
  const vimeo = u.hostname.replace(/^www\.|^player\./, "") === "vimeo.com" ? u.pathname.match(/\/(?:video\/)?(\d{5,})/)?.[1] : undefined;
  if (vimeo) return { url: `https://vimeo.com/${vimeo}`, thumb: httpUrl(thumbnail), embed: `https://player.vimeo.com/video/${vimeo}?autoplay=1` };
  if (/\.(mp4|webm)$/i.test(u.pathname)) return { url: href, thumb: httpUrl(thumbnail), embed: href };
  return null;
}
