import type { SubdomainLang } from '@/shared/components/types/fat-footer'

export type FooterItem = {
  text: string
  translatedText?: string
  url?: string
  class?: string
  label?: string
  group?: 'lumia-community'
  icon?: string
  target?: '_blank' | '_self'
}

export type FooterMetadata = {
  showThinFooter: boolean
  translatedLanguages: { [key: string]: string }
  showPoweredBy?: boolean
  subdomainLang?: SubdomainLang
  leftItems?: FooterItem[]
  rightItems?: FooterItem[]
}
