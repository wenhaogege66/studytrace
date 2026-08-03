import type { MetadataRoute } from "next"

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://studytrace.vercel.app",
      changeFrequency: "monthly",
      priority: 1,
    },
    {
      url: "https://studytrace.vercel.app/app",
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ]
}
