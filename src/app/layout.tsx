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
    default: "学迹 StudyTrace｜自律执行与本地过程观察",
    template: "%s｜学迹 StudyTrace",
  },
  description:
    "把任务设计、AI 拆解、多次执行、本地视觉观察、复盘与长期规律连成闭环的隐私优先自律工具。",
  keywords: [
    "自律工具",
    "任务管理",
    "长期洞察",
    "计算机视觉",
    "隐私优先",
    "StudyTrace",
  ],
  openGraph: {
    title: "学迹 StudyTrace",
    description:
      "任务设计、执行记录与事实型长期洞察一体化的自律工具。画面只在本地处理。",
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
