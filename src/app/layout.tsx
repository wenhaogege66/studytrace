import type { Metadata, Viewport } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
})

export const metadata: Metadata = {
  metadataBase: new URL("https://studytrace.vercel.app"),
  title: {
    default: "学迹 StudyTrace｜学习计划、过程观察与学习报告",
    template: "%s｜学迹 StudyTrace",
  },
  description:
    "从学习意图、AI 推荐方案到多次学习、学习复盘与学习报告。本地过程观察默认不上传，可选云端分析需单独授权。",
  keywords: [
    "自律工具",
    "学习计划",
    "学习报告",
    "计算机视觉",
    "隐私优先",
    "StudyTrace",
  ],
  openGraph: {
    title: "学迹 StudyTrace",
    description:
      "学习计划、过程观察、学习复盘与学习报告的执行闭环。本地观察默认不上传，可选云端分析需单独授权。",
    type: "website",
    locale: "zh_CN",
  },
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#4338ca",
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable}`}
      data-scroll-behavior="smooth"
    >
      <body className="min-h-full">{children}</body>
    </html>
  )
}
