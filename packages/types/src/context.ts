type MaybeRefValue<T> = T | { value?: T }

export interface SlidevContextNav {
  currentSlideNo?: MaybeRefValue<number>
  clicks?: MaybeRefValue<number>
  clicksTotal?: MaybeRefValue<number>
  hasNext?: MaybeRefValue<boolean>
  next?: () => Promise<void> | void
}

export interface SlidevContext {
  nav?: SlidevContextNav
}

declare global {
  interface Window {
    __slidev__?: SlidevContext
  }
}
