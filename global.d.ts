declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

type MolstarViewerInstance = {
  plugin?: {
    clear?: () => void | Promise<void>
  }
  loadStructureFromUrl: (
    url: string,
    format?: string,
    isBinary?: boolean,
    options?: unknown
  ) => void | Promise<void>
  dispose?: () => void
}

type MolstarViewerNamespace = {
  create: (
    target: string | HTMLElement,
    options?: Record<string, unknown>
  ) => Promise<MolstarViewerInstance>
}

interface Window {
  molstar?: {
    Viewer: MolstarViewerNamespace
  }
}
