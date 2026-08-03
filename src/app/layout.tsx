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
    default: "学迹 StudyTrace｜任务管理与本地注意状态观察",
    template: "%s｜学迹 StudyTrace",
  },
  description:
    "把任务拆分、学习计时、本地视觉观察与一次复盘连成闭环的隐私优先学习辅助系统。",
  keywords: ["学习辅助", "任务管理", "计算机视觉", "隐私优先", "StudyTrace"],
  openGraph: {
    title: "学迹 StudyTrace",
    description: "任务管理与注意状态观察一体化学习辅助系统。画面只在本地处理。",
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
