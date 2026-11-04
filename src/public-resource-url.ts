export interface HaneokaResourceScope {
  readonly origin: string;
  readonly server: string;
  readonly releaseId: string;
}

/** Preserve the immutable identity while addressing the public server endpoint. */
export function haneokaResourceRequestUrl(source: string, scope: HaneokaResourceScope): string {
  const url = new URL(source);
  if (url.origin === scope.origin) {
    const parts = url.pathname.split("/");
    if (["runtime", "assets", "objects"].includes(parts[1] ?? "")) {
      if (parts[2] !== scope.releaseId && parts[2] !== scope.server)
        throw new TypeError("Resource does not belong to the selected release");
      const pins = url.searchParams.getAll("release");
      if (pins.length > 1 || (pins.length === 1 && pins[0] !== scope.releaseId))
        throw new TypeError("Resource release changed");
      parts[2] = scope.server;
      url.pathname = parts.join("/");
      url.searchParams.set("release", scope.releaseId);
    }
  }
  return url.href;
}
