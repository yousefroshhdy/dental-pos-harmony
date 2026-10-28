import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Honest OS",
    short_name: "Honest OS",
    description: "The operating system of Honest®",
    start_url: "/ar",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f8fb",
    theme_color: "#1f5fa8",
    lang: "ar",
    dir: "rtl",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
