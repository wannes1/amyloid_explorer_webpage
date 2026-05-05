import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import {
  CosmographProvider,
  Cosmograph,
  CosmographRef,
  CosmographSearch,
  CosmographSearchRef,
  CosmographTypeColorLegend,
} from '@cosmograph/react'
import s from './style.module.css'

export const title = 'Basic usage (React)'
export const subTitle = 'Changing data and config'
export const category = 'General'

type CsvRow = Record<string, string>

type GraphPoint = {
  [key: string]: string | number | undefined
  id: string
  idx: number
  cluster_thermodynamics: number
  cluster: number
  Protein?: string
  cluster_color_thermodynamics?: string
  cluster_color?: string
  node_size: number
}

type GraphLink = {
  source: string
  sourceidx: number
  target: string
  targetidx: number
  value: number
}

type GraphDataset = {
  points: GraphPoint[]
  links: GraphLink[]
}

type PointColorOption = {
  key: string
  label: string
  strategy: 'continuous' | 'categorical' | 'direct'
  description: string
}

type TypeLegendState = {
  show: boolean
  label: string
  sortBy?: string
}

type PointColorConfig = {
  pointColorBy: string
  pointColorStrategy?:
    | 'map'
    | 'categorical'
    | 'continuous'
    | 'direct'
    | 'degree'
    | 'preciseDegree'
    | 'linkDirection'
    | 'single'
  pointColorByMap?: Record<string, string>
}

type PanelView = 'graph' | 'filters' | 'info'
type GraphConfigView = 'points' | 'links'

const MOLSTAR_TARGET_ID = 'molstar-viewer-root'
const DATABASE_BASE_URL = 'https://amyloid-explorer.switchlab.org/database/'
const initialSuggestionFields: Record<string, string> = {
  id: 'PDB Code',
  Protein: 'Protein',
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export const component = (): React.JSX.Element => {
  const [data, setData] = useState<GraphDataset | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedPoint, setSelectedPoint] = useState<GraphPoint | null>(null)
  const [colorOptions, setColorOptions] = useState<PointColorOption[]>([])
  const [colorByKey, setColorByKey] = useState('cluster_thermodynamics')
  const [panelView, setPanelView] = useState<PanelView>('graph')
  const [graphConfigView, setGraphConfigView] = useState<GraphConfigView>('points')
  const [pointSizeScale, setPointSizeScale] = useState(4)
  const [pointLabelByKey, setPointLabelByKey] = useState('Protein')
  const [showPointLabels, setShowPointLabels] = useState(true)
  const [showLinks, setShowLinks] = useState(true)
  const [edgeWidthScale, setEdgeWidthScale] = useState(0.1)
  const [isProteinLoading, setIsProteinLoading] = useState(false)
  const [proteinError, setProteinError] = useState<string | null>(null)
  const [loadedProteinLabel, setLoadedProteinLabel] = useState('No node selected')
  const [isMolstarReady, setIsMolstarReady] = useState(false)
  const [isMolstarExpanded, setIsMolstarExpanded] = useState(false)
  const [proteinColorByBFactor, setProteinColorByBFactor] = useState(true)
  const [proteinEnergyDomain, setProteinEnergyDomain] = useState<[number, number] | null>(null)
  const [proteinFilter, setProteinFilter] = useState('all')
  const [clusterFilter, setClusterFilter] = useState('all')
  const [structuralClusterFilter, setStructuralClusterFilter] = useState('all')
  const [expMethodFilter, setExpMethodFilter] = useState('all')
  const [diseaseFilter, setDiseaseFilter] = useState('all')
  const [isClusterModalOpen, setIsClusterModalOpen] = useState(false)
  const [isClusterImageExpanded, setIsClusterImageExpanded] = useState(false)
  const [clusterImageHasError, setClusterImageHasError] = useState(false)

  const cosmograph = useRef<CosmographRef | null>(null)
  const search = useRef<CosmographSearchRef>(undefined)
  const searchOverlayRef = useRef<HTMLDivElement | null>(null)
  const molstarViewerRef = useRef<MolstarViewerInstance | null>(null)

  const buildColorOptions = useCallback((sample: CsvRow): PointColorOption[] => {
    const options: PointColorOption[] = []

    const addOption = (option: PointColorOption) => {
      if (sample[option.key] !== undefined) {
        options.push(option)
      }
    }
    addOption({
      key: 'cluster_color_thermodynamics',
      label: 'Thermodynamics cluster',
      strategy: 'direct',
      description: 'Use hex colors directly from cluster_color_thermodynamics.',
    })
    addOption({
      key: 'cluster_color',
      label: 'Structural cluster',
      strategy: 'direct',
      description: 'Use hex colors directly from cluster_color.',
    })
    addOption({
      key: 'Protein',
      label: 'Protein',
      strategy: 'categorical',
      description: 'Categorical palette assigning a distinct color to each protein.',
    })

    return options
  }, [])

  const toNumber = useCallback((value?: string) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
  }, [])

  const toIndex = useCallback((value?: number) => {
    if (value === undefined) return null
    const n = Number(value)
    return Number.isFinite(n) ? Math.trunc(n) : null
  }, [])

  const parseEnergyDomainFromPdb = useCallback((pdbText: string): [number, number] | null => {
    const values: number[] = []

    for (const line of pdbText.split(/\r?\n/)) {
      if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) {
        continue
      }

      // PDB B-factor/energy proxy is in columns 61-66 (1-based indexing).
      const raw = line.slice(60, 66).trim()
      const value = Number(raw)

      if (!Number.isFinite(value)) {
        continue
      }

      values.push(value)
    }

    if (values.length === 0) {
      return null
    }

    const vmin = Math.min(...values)
    const vmax = Math.max(...values)
    const absmax = Math.max(Math.abs(vmin), Math.abs(vmax))

    const symmetricDomain: [number, number] =
      absmax === 0 ? [-1, 1] : [-absmax, absmax]

    return symmetricDomain
  }, [])

  const parseCsv = useCallback((text: string): CsvRow[] => {
    const lines = text.trim().split(/\r?\n/)
    if (!lines.length) return []

    const parseLine = (line: string): string[] => {
      const result: string[] = []
      let current = ''
      let inQuotes = false

      for (let i = 0; i < line.length; i += 1) {
        const char = line[i]
        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"'
            i += 1
          } else {
            inQuotes = !inQuotes
          }
        } else if (char === ',' && !inQuotes) {
          result.push(current)
          current = ''
        } else {
          current += char
        }
      }

      result.push(current)
      return result
    }

    const headers = parseLine(lines[0])

    return lines.slice(1).filter(Boolean).map(line => {
      const values = parseLine(line)
      return headers.reduce<CsvRow>((acc, header, idx) => {
        acc[header] = values[idx] ?? ''
        return acc
      }, {})
    })
  }, [])

  const loadData = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const [nodesRes, edgesRes] = await Promise.all([
        fetch('data/thermodynamics_nodes_merged_with_description.csv'),
        fetch('data/thermodynamics_edges.csv'),
      ])

      if (!nodesRes.ok || !edgesRes.ok) {
        throw new Error('Failed to fetch CSV files. Ensure data/ is served next to index.html.')
      }

      const [nodesText, edgesText] = await Promise.all([nodesRes.text(), edgesRes.text()])
      const nodeRows = parseCsv(nodesText)
      const edgeRows = parseCsv(edgesText)
      const firstNode = nodeRows[0] ?? {}
      const availableColorOptions = buildColorOptions(firstNode)

      setColorOptions(availableColorOptions)
      setColorByKey(prev => {
        const stillExists = availableColorOptions.some(option => option.key === prev)
        return stillExists ? prev : availableColorOptions[0]?.key ?? 'cluster_thermodynamics'
      })
      setSelectedPoint(null)

      const nodeIndex = new Map<string, number>()
      const points: GraphPoint[] = nodeRows.map((row, idx) => {
        const id = row.id || `node-${idx}`
        nodeIndex.set(id, idx)

        const clusterThermo = toNumber(row.cluster_thermodynamics)
        const cluster = toNumber(row.cluster)
        const pointIndex = toIndex(idx) ?? 0
        return {
          ...row,
          id,
          idx: pointIndex,
          cluster_thermodynamics: clusterThermo,
          cluster,
          node_size: 1,
        }
      })

      const links: GraphLink[] = edgeRows
        .map(row => {
          const sourceIndex = toIndex(nodeIndex.get(row.source))
          const targetIndex = toIndex(nodeIndex.get(row.target))
          if (sourceIndex === null || targetIndex === null) return null

          return {
            source: row.source,
            sourceidx: sourceIndex,
            target: row.target,
            targetidx: targetIndex,
            value: toNumber(row.weight),
          }
        })
        .filter((link): link is GraphLink => link !== null)

      setData({ points, links })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error while loading data'
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }, [parseCsv, toNumber, toIndex])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const details = event.error instanceof Error
        ? event.error.stack ?? event.error.message
        : event.message
      setError(details || 'Runtime error occurred while rendering the graph.')
    }

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      if (reason instanceof Error) {
        setError(reason.stack ?? reason.message)
        return
      }

      setError(typeof reason === 'string' ? reason : 'Unhandled async error occurred while rendering the graph.')
    }

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)

    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  const proteinFilterOptions = useMemo(() => {
    if (!data) return []

    const values = new Set<string>()
    data.points.forEach(point => {
      const value = point.Protein
      values.add(value === undefined || value === '' ? 'Unknown' : String(value))
    })

    return Array.from(values).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    )
  }, [data])

  const clusterFilterOptions = useMemo(() => {
    if (!data) return []

    const values = new Set<string>()
    data.points.forEach(point => {
      const value = point.cluster_thermodynamics
      values.add(value === undefined ? 'Unknown' : String(value))
    })

    return Array.from(values).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    )
  }, [data])

  const structuralClusterFilterOptions = useMemo(() => {
    if (!data) return []

    const values = new Set<string>()
    data.points.forEach(point => {
      const value = point.cluster
      values.add(value === undefined ? 'Unknown' : String(value))
    })

    return Array.from(values).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    )
  }, [data])

  const expMethodFilterOptions = useMemo(() => {
    if (!data) return []

    const values = new Set<string>()
    data.points.forEach(point => {
      const value = point['Exp. Method']
      values.add(value === undefined || value === '' ? 'Unknown' : String(value))
    })

    return Array.from(values).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    )
  }, [data])

  const diseaseFilterOptions = useMemo(() => {
    if (!data) return []

    const values = new Set<string>()
    data.points.forEach(point => {
      const value = point.Disease
      values.add(value === undefined || value === '' ? 'Unknown' : String(value))
    })

    return Array.from(values).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    )
  }, [data])

  useEffect(() => {
    if (proteinFilter !== 'all' && !proteinFilterOptions.includes(proteinFilter)) {
      setProteinFilter('all')
    }

    if (clusterFilter !== 'all' && !clusterFilterOptions.includes(clusterFilter)) {
      setClusterFilter('all')
    }

    if (
      structuralClusterFilter !== 'all' &&
      !structuralClusterFilterOptions.includes(structuralClusterFilter)
    ) {
      setStructuralClusterFilter('all')
    }

    if (expMethodFilter !== 'all' && !expMethodFilterOptions.includes(expMethodFilter)) {
      setExpMethodFilter('all')
    }

    if (diseaseFilter !== 'all' && !diseaseFilterOptions.includes(diseaseFilter)) {
      setDiseaseFilter('all')
    }
  }, [
    clusterFilter,
    clusterFilterOptions,
    diseaseFilter,
    diseaseFilterOptions,
    expMethodFilter,
    expMethodFilterOptions,
    proteinFilter,
    proteinFilterOptions,
    structuralClusterFilter,
    structuralClusterFilterOptions,
  ])

  const currentDataset = useMemo<GraphDataset>(() => {
    if (!data) {
      return { points: [], links: [] }
    }

    return data
  }, [data])

  const allPointIndices = useMemo(
    () => currentDataset.points.map(point => point.idx),
    [currentDataset.points]
  )

  useEffect(() => {
    if (!selectedPoint) return

    const stillVisible = currentDataset.points.some(point => point.id === selectedPoint.id)
    if (!stillVisible) {
      setSelectedPoint(null)
    }
  }, [currentDataset.points, selectedPoint])

  const selectedColorOption = useMemo(
    () => colorOptions.find(option => option.key === colorByKey) ?? colorOptions[0] ?? null,
    [colorOptions, colorByKey]
  )

  const pointColorConfig = useMemo<PointColorConfig>(() => {
    const validHexColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
    const fallbackColor = '#9aa5b1'

    const normalizeHexColor = (value: string | number | undefined): string => {
      if (typeof value !== 'string') return fallbackColor
      const trimmed = value.trim()
      return validHexColor.test(trimmed) ? trimmed : fallbackColor
    }

    const toCategory = (value: string | number | undefined): string => {
      if (value === undefined || value === '') return 'Unknown'
      return String(value)
    }

    if (colorByKey === 'cluster_color_thermodynamics') {
      const pointColorByMap: Record<string, string> = {}

      currentDataset.points.forEach(point => {
        const category = toCategory(point.cluster_thermodynamics)
        if (pointColorByMap[category] !== undefined) return
        pointColorByMap[category] = normalizeHexColor(point.cluster_color_thermodynamics)
      })

      return {
        pointColorBy: 'cluster_thermodynamics',
        pointColorStrategy: 'map',
        pointColorByMap,
      }
    }

    if (colorByKey === 'cluster_color') {
      const pointColorByMap: Record<string, string> = {}

      currentDataset.points.forEach(point => {
        const category = toCategory(point.cluster)
        if (pointColorByMap[category] !== undefined) return
        pointColorByMap[category] = normalizeHexColor(point.cluster_color)
      })

      return {
        pointColorBy: 'cluster',
        pointColorStrategy: 'map',
        pointColorByMap,
      }
    }

    if (colorByKey === 'Protein') {
      return {
        pointColorBy: 'Protein',
        pointColorStrategy: 'categorical',
      }
    }

    return {
      pointColorBy: selectedColorOption?.key || 'id',
      pointColorStrategy: selectedColorOption?.strategy,
    }
  }, [colorByKey, currentDataset.points, selectedColorOption?.key, selectedColorOption?.strategy])

  const typeLegendState = useMemo<TypeLegendState>(() => {
    if (colorByKey === 'cluster_color_thermodynamics') {
      return {
        show: true,
        label: 'Thermodynamics cluster',
        sortBy: 'cluster_color_thermodynamics',
      }
    }

    if (colorByKey === 'cluster_color') {
      return {
        show: true,
        label: 'Structural cluster',
        sortBy: 'cluster',
      }
    }

    if (colorByKey === 'Protein') {
      return {
        show: true,
        label: 'Protein',
        sortBy: 'Protein',
      }
    }

    return {
      show: false,
      label: '',
      sortBy: undefined,
    }
  }, [colorByKey])

  const pointLabelOptions = useMemo(
    () => [
      { key: 'id', label: 'PDB Code' },
      { key: 'Protein', label: 'Protein' },
      { key: 'cluster_thermodynamics', label: 'Thermodynamics cluster' },
      { key: 'cluster', label: 'Structural cluster' },
    ],
    []
  )

  useEffect(() => {
    if (!pointLabelOptions.some(option => option.key === pointLabelByKey)) {
      setPointLabelByKey(pointLabelOptions[0]?.key ?? 'Protein')
    }
  }, [pointLabelByKey, pointLabelOptions])

  const handleSearchSelect = useCallback(
    (result?: Record<string, string | number>) => {
      if (!result) {
        setSelectedPoint(null)
        cosmograph.current?.unselectAllPoints()
        return
      }

      const searchId = result.id === undefined ? null : String(result.id)
      const rawIdx = result.idx
      const idx = typeof rawIdx === 'number' ? rawIdx : Number(rawIdx)

      if (Number.isFinite(idx) && idx >= 0) {
        const pointIndex = Math.trunc(idx)
        const matchedPoint =
          currentDataset.points[pointIndex] ??
          (searchId
            ? currentDataset.points.find(point => point.id === searchId) ?? null
            : null)

        if (matchedPoint) {
          setSelectedPoint(matchedPoint)
          cosmograph.current?.selectPoints([matchedPoint.idx], false)
        }

        return
      }

      if (!searchId) return

      const matchedPoint = currentDataset.points.find(point => point.id === searchId) ?? null
      if (!matchedPoint) return

      setSelectedPoint(matchedPoint)
      cosmograph.current?.selectPoints([matchedPoint.idx], false)
    },
    [currentDataset.points]
  )

  const handleGraphClick = useCallback(
    (pointIndex?: number) => {
      if (typeof pointIndex === 'number' && pointIndex >= 0) {
        setSelectedPoint(currentDataset.points[pointIndex] ?? null)
      } else {
        setSelectedPoint(null)
      }
    },
    [currentDataset.points]
  )

  const hasGraphData = currentDataset.points.length > 0

  const activeFilterCount = useMemo(() => {
    return [
      proteinFilter,
      clusterFilter,
      structuralClusterFilter,
      expMethodFilter,
      diseaseFilter,
    ].filter(value => value !== 'all').length
  }, [clusterFilter, diseaseFilter, expMethodFilter, proteinFilter, structuralClusterFilter])

  const highlightedPointIndices = useMemo(() => {
    if (activeFilterCount === 0) return null

    return currentDataset.points
      .filter(point => {
        const proteinValue = point.Protein === undefined || point.Protein === '' ? 'Unknown' : String(point.Protein)
        const thermoClusterValue = point.cluster_thermodynamics === undefined
          ? 'Unknown'
          : String(point.cluster_thermodynamics)
        const structuralClusterValue = point.cluster === undefined ? 'Unknown' : String(point.cluster)
        const expMethodValue = point['Exp. Method'] === undefined || point['Exp. Method'] === ''
          ? 'Unknown'
          : String(point['Exp. Method'])
        const diseaseValue = point.Disease === undefined || point.Disease === ''
          ? 'Unknown'
          : String(point.Disease)

        if (proteinFilter !== 'all' && proteinValue !== proteinFilter) return false
        if (clusterFilter !== 'all' && thermoClusterValue !== clusterFilter) return false
        if (structuralClusterFilter !== 'all' && structuralClusterValue !== structuralClusterFilter) return false
        if (expMethodFilter !== 'all' && expMethodValue !== expMethodFilter) return false
        if (diseaseFilter !== 'all' && diseaseValue !== diseaseFilter) return false

        return true
      })
      .map(point => point.idx)
  }, [
    activeFilterCount,
    clusterFilter,
    currentDataset.points,
    diseaseFilter,
    expMethodFilter,
    proteinFilter,
    structuralClusterFilter,
  ])

  const highlightedPointCount = useMemo(() => {
    if (activeFilterCount === 0) return currentDataset.points.length
    return highlightedPointIndices?.length ?? 0
  }, [activeFilterCount, currentDataset.points.length, highlightedPointIndices])

  const shouldGreyAllPoints = activeFilterCount > 0 && highlightedPointCount === 0

  const applyHighlightSelection = useCallback((graph?: CosmographRef | null) => {
    const instance = graph ?? cosmograph.current
    if (!instance) return

    if (!highlightedPointIndices || highlightedPointIndices.length === 0) {
      instance.unselectAllPoints()
      return
    }

    instance.selectPoints(highlightedPointIndices, false)
  }, [highlightedPointIndices])

  const handleGraphMount = useCallback(
    (graph?: CosmographRef | null) => {
      applyHighlightSelection(graph)

      if (!graph || allPointIndices.length === 0) return

      graph.fitViewByIndices(allPointIndices, 0, 0.1)
    },
    [allPointIndices, applyHighlightSelection]
  )

  useEffect(() => {
    applyHighlightSelection()
  }, [applyHighlightSelection, hasGraphData])

  useEffect(() => {
    const overlay = searchOverlayRef.current
    if (!overlay) return

    const allowedLabels = new Set(['all fields', 'pdb code', 'protein'])
    const hiddenSuggestionFields = new Set(['cluster_color_thermodynamics', 'node_size'])

    const restrictAccessorMenu = () => {
      const menu = overlay.querySelector<HTMLElement>("[class*='accessorsMenu']")
      if (!menu) return

      const items = Array.from(menu.querySelectorAll<HTMLLIElement>('li'))
      items.forEach(item => {
        const label = (item.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
        const isAllowed = allowedLabels.has(label)
        item.hidden = !isAllowed
        item.style.display = isAllowed ? '' : 'none'
        item.setAttribute('aria-hidden', isAllowed ? 'false' : 'true')
      })
    }

    const hideSuggestionFields = () => {
      const results = Array.from(
        overlay.querySelectorAll<HTMLElement>("[class*='searchResultMultiField']")
      )

      results.forEach(result => {
        const fieldNodes = Array.from(result.querySelectorAll<HTMLElement>('span'))

        fieldNodes.forEach(fieldNode => {
          const labelNode = fieldNode.querySelector('b')
          if (!labelNode) return

          const label = (labelNode.textContent ?? '')
            .replace(/:/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase()

          if (!hiddenSuggestionFields.has(label)) return

          const prev = fieldNode.previousElementSibling as HTMLElement | null
          const next = fieldNode.nextElementSibling as HTMLElement | null

          fieldNode.remove()

          if (prev?.matches("[class*='separator']")) {
            prev.remove()
          } else if (next?.matches("[class*='separator']")) {
            next.remove()
          }
        })

        const listItem = result.closest('li') as HTMLLIElement | null
        if (!listItem) return

        const hasAnyField = result.querySelector('b') !== null
        listItem.hidden = !hasAnyField
        listItem.style.display = hasAnyField ? '' : 'none'
        listItem.setAttribute('aria-hidden', hasAnyField ? 'false' : 'true')
      })
    }

    restrictAccessorMenu()
    hideSuggestionFields()

    const observer = new MutationObserver(() => {
      restrictAccessorMenu()
      hideSuggestionFields()
    })

    observer.observe(overlay, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
    }
  }, [])

  const selectedPointEntries = useMemo(() => {
    if (!selectedPoint) return []

    const visibleFields: Array<{ key: string; label: string }> = [
      { key: 'id', label: 'PDB Code' },
      { key: 'Protein', label: 'Protein' },
      { key: 'cluster_thermodynamics', label: 'Thermodynamics cluster' },
      { key: 'cluster', label: 'Structural cluster' },
      { key: 'Structure Title', label: 'Structure Title' },
      { key: 'Exp. Method', label: 'Experimental method' },
      { key: 'Disease', label: 'Disease' },
    ]

    return visibleFields.map(field => {
      const rawValue = selectedPoint[field.key]
      const displayValue = rawValue === undefined || rawValue === '' ? 'N/A' : String(rawValue)

      return {
        key: field.key,
        label: field.label,
        value: displayValue,
      }
    })
  }, [selectedPoint])

  const selectedPointDatabaseUrl = useMemo(() => {
    if (!selectedPoint) return null

    const protein = selectedPoint.Protein
    const pdbId = selectedPoint.id

    if (!protein || !pdbId) return null

    const encodedProtein = encodeURIComponent(String(protein))
    const encodedPdb = encodeURIComponent(String(pdbId).toUpperCase())

    return `${DATABASE_BASE_URL}${encodedProtein}?strct=${encodedPdb}`
  }, [selectedPoint])

  const selectedThermodynamicsCluster = useMemo(() => {
    if (!selectedPoint) return null

    const rawValue = selectedPoint.cluster_thermodynamics
    const numericValue = Number(rawValue)
    if (!Number.isFinite(numericValue)) return null

    return Math.trunc(numericValue)
  }, [selectedPoint])

  const selectedThermodynamicsImageName = useMemo(() => {
    if (selectedThermodynamicsCluster === null) return null
    return `multiple_alignments/thermodynamics_cluster_${selectedThermodynamicsCluster}_msa_dendrogram.png`
  }, [selectedThermodynamicsCluster])

  const selectedThermodynamicsImageUrl = useMemo(() => {
    if (!selectedThermodynamicsImageName) return null
    return `data/${selectedThermodynamicsImageName}`
  }, [selectedThermodynamicsImageName])

  const openThermodynamicsClusterModal = useCallback(() => {
    if (!selectedThermodynamicsImageUrl) return
    setClusterImageHasError(false)
    setIsClusterModalOpen(true)
  }, [selectedThermodynamicsImageUrl])

  const closeThermodynamicsClusterModal = useCallback(() => {
    setIsClusterModalOpen(false)
    setIsClusterImageExpanded(false)
  }, [])

  const openThermodynamicsClusterFullscreen = useCallback(() => {
    if (!selectedThermodynamicsImageUrl || clusterImageHasError) return
    setIsClusterImageExpanded(true)
  }, [clusterImageHasError, selectedThermodynamicsImageUrl])

  const closeThermodynamicsClusterFullscreen = useCallback(() => {
    setIsClusterImageExpanded(false)
  }, [])

  const openSelectedPointDatabasePage = useCallback(() => {
    if (!selectedPointDatabaseUrl) return
    window.open(selectedPointDatabaseUrl, '_blank', 'noopener,noreferrer')
  }, [selectedPointDatabaseUrl])

  useEffect(() => {
    if (!isClusterModalOpen && !isClusterImageExpanded) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (isClusterImageExpanded) {
          setIsClusterImageExpanded(false)
          return
        }

        setIsClusterModalOpen(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isClusterImageExpanded, isClusterModalOpen])

  useEffect(() => {
    setClusterImageHasError(false)
  }, [selectedThermodynamicsImageUrl])

  useEffect(() => {
    if (!isClusterImageExpanded) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [isClusterImageExpanded])

  useEffect(() => {
    if (!selectedPoint) {
      setIsClusterModalOpen(false)
      setIsClusterImageExpanded(false)
    }
  }, [selectedPoint])

  const strategyLabel = useMemo(() => {
    if (!selectedColorOption) return 'N/A'
    if (selectedColorOption.strategy === 'categorical') return 'Categorical'
    if (selectedColorOption.strategy === 'continuous') return 'Continuous'
    return 'Direct'
  }, [selectedColorOption])

  const hasEnergyLegend = proteinColorByBFactor && proteinEnergyDomain !== null
  const energyLegendMin = hasEnergyLegend ? proteinEnergyDomain[0] : null
  const energyLegendMax = hasEnergyLegend ? proteinEnergyDomain[1] : null
  const formatEnergyValue = (value: number) =>
    value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })

  const clearFilters = useCallback(() => {
    setProteinFilter('all')
    setClusterFilter('all')
    setStructuralClusterFilter('all')
    setExpMethodFilter('all')
    setDiseaseFilter('all')
  }, [])

  useEffect(() => {
    if (panelView !== 'info' && isMolstarExpanded) {
      setIsMolstarExpanded(false)
    }
  }, [isMolstarExpanded, panelView])

  useEffect(() => {
    if (!isMolstarExpanded) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMolstarExpanded(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isMolstarExpanded])

  useEffect(() => {
    let cancelled = false

    if (panelView !== 'info') {
      if (molstarViewerRef.current?.dispose) {
        molstarViewerRef.current.dispose()
      }

      molstarViewerRef.current = null
      setIsMolstarReady(false)
      setIsProteinLoading(false)
      setProteinEnergyDomain(null)
      return () => {
        cancelled = true
      }
    }

    const createMolstarViewer = async () => {
      try {
        if (!window.molstar?.Viewer) {
          throw new Error('Molstar is not available. Check the Molstar script include in index.html.')
        }

        setIsMolstarReady(false)

        const target = document.getElementById(MOLSTAR_TARGET_ID)
        if (!target) {
          throw new Error('Molstar mount target is missing from the DOM.')
        }

        if (molstarViewerRef.current?.dispose) {
          molstarViewerRef.current.dispose()
          molstarViewerRef.current = null
        }

        const viewer = await window.molstar.Viewer.create(MOLSTAR_TARGET_ID, {
          layoutIsExpanded: false,
          layoutShowControls: isMolstarExpanded,
          layoutShowLeftPanel: isMolstarExpanded,
          layoutShowRemoteState: false,
          collapseLeftPanel: !isMolstarExpanded,
          viewportShowExpand: false,
          viewportShowSelectionMode: false,
          viewportShowAnimation: false,
        })

        if (cancelled) {
          if (viewer.dispose) {
            viewer.dispose()
          }
          return
        }

        molstarViewerRef.current = viewer
        setProteinError(null)
        setIsMolstarReady(true)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not initialize Molstar viewer.'
        setProteinError(message)
        setIsMolstarReady(false)
        setProteinEnergyDomain(null)
      }
    }

    void createMolstarViewer()

    return () => {
      cancelled = true
    }
  }, [isMolstarExpanded, panelView])

  useEffect(() => {
    const viewer = molstarViewerRef.current
    if (!viewer || panelView !== 'info' || !isMolstarReady) return

    let cancelled = false

    const selectedId = selectedPoint?.id ? String(selectedPoint.id) : null
    if (!selectedId) {
      const clearViewer = async () => {
        if (viewer.plugin?.clear) {
          await viewer.plugin.clear()
        }

        if (!cancelled) {
          setIsProteinLoading(false)
          setProteinError(null)
          setLoadedProteinLabel('No node selected')
          setProteinEnergyDomain(null)
        }
      }

      void clearViewer()

      return () => {
        cancelled = true
      }
    }

    const nodeFileUrl = `data/stamp_b_factor_residue_pdbs_corrected/${encodeURIComponent(selectedId)}.pdb`

    const loadStructure = async () => {
      setIsProteinLoading(true)
      setProteinError(null)
      setProteinEnergyDomain(null)

      let lastError: unknown = null
      let resolvedUrl: string | null = null
      let resolvedPdbText: string | null = null

      try {
        const absoluteUrl = new URL(nodeFileUrl, window.location.href).toString()
        const res = await fetch(absoluteUrl)

        if (!res.ok) {
          const warning =
            res.status === 404
              ? `[Molstar] Structure file not found for ${selectedId}: ${nodeFileUrl}`
              : `[Molstar] Failed to fetch structure for ${selectedId} (${nodeFileUrl}): HTTP ${res.status}`
          console.warn(warning)

          try {
            if (viewer.plugin?.clear) {
              await viewer.plugin.clear()
            }
          } catch (clearError) {
            console.warn(`[Molstar] Could not clear previous structure after fetch failure for ${selectedId}:`, clearError)
          }

          if (!cancelled) {
            setProteinError(`No structure file found for ${selectedId}.`)
            setIsProteinLoading(false)
            setLoadedProteinLabel('Missing structure')
            setProteinEnergyDomain(null)
          }
          return
        }

        resolvedUrl = nodeFileUrl
        resolvedPdbText = await res.text()
      } catch (err) {
        lastError = err
      }

      if (!resolvedUrl) {
        try {
          if (viewer.plugin?.clear) {
            await viewer.plugin.clear()
          }
        } catch (clearError) {
          console.warn(`[Molstar] Could not clear previous structure after load error for ${selectedId}:`, clearError)
        }

        if (!cancelled) {
          console.warn(`[Molstar] Error loading structure for ${selectedId}:`, lastError)
          const message =
            lastError instanceof Error
              ? lastError.message
              : `No structure file found for ${selectedId}.`
          setProteinError(message)
          setIsProteinLoading(false)
          setLoadedProteinLabel('Missing structure')
          setProteinEnergyDomain(null)
        }
        return
      }

      try {
        if (viewer.plugin?.clear) {
          await viewer.plugin.clear()
        }

        const absoluteResolvedUrl = new URL(resolvedUrl, window.location.href).toString()
        const energyDomain = resolvedPdbText
          ? parseEnergyDomainFromPdb(resolvedPdbText)
          : null
        const resolvedEnergyDomain: [number, number] = energyDomain ?? [-1, 1]
        let didApplyEnergyTheme = false

        if (proteinColorByBFactor) {
          try {
            await Promise.resolve(
              viewer.loadStructureFromUrl(absoluteResolvedUrl, 'pdb', false, {
                representationParams: {
                  // Use Molstar's B-factor theme as an energy profile with a custom color scale.
                  theme: {
                    globalName: 'uncertainty',
                    globalColorParams: {
                      domain: resolvedEnergyDomain,
                      list: {
                        kind: 'interpolate',
                        colors: [
                          0xff0000, // red
                          0xffffff, // white
                          0x0000ff, // blue
                        ],
                      },
                    },
                  },
                },
              })
            )
            didApplyEnergyTheme = true
          } catch {
            // Fallback to the default preset if the B-factor theme isn't available for this file.
            await Promise.resolve(viewer.loadStructureFromUrl(absoluteResolvedUrl, 'pdb', false))
            didApplyEnergyTheme = false
          }
        } else {
          await Promise.resolve(viewer.loadStructureFromUrl(absoluteResolvedUrl, 'pdb', false))
        }

        if (!cancelled) {
          setLoadedProteinLabel(resolvedUrl.split('/').pop() ?? `${selectedId}.pdb`)
          setIsProteinLoading(false)
          setProteinEnergyDomain(didApplyEnergyTheme ? resolvedEnergyDomain : null)
        }

        return
      } catch (err) {
        lastError = err
      }

      if (!cancelled) {
        const message = lastError instanceof Error ? lastError.message : 'Failed to load structure file.'
        setProteinError(message)
        setIsProteinLoading(false)
        setProteinEnergyDomain(null)
      }
    }

    void loadStructure()

    return () => {
      cancelled = true
    }
  }, [isMolstarReady, panelView, parseEnergyDomainFromPdb, proteinColorByBFactor, selectedPoint?.id])

  useEffect(() => {
    return () => {
      if (molstarViewerRef.current?.dispose) {
        molstarViewerRef.current.dispose()
      }

      molstarViewerRef.current = null
    }
  }, [])

  return (
    <CosmographProvider>
      <div className={s.mainContainer}>
        <nav className={s.selectionRail} aria-label="Panel sections">
          <button
            type="button"
            className={`${s.railButton} ${panelView === 'graph' ? s.railButtonActive : ''}`}
            onClick={() => setPanelView('graph')}
          >
            Graph
          </button>
          <button
            type="button"
            className={`${s.railButton} ${panelView === 'filters' ? s.railButtonActive : ''}`}
            onClick={() => setPanelView('filters')}
          >
            Filters
          </button>
          <button
            type="button"
            className={`${s.railButton} ${panelView === 'info' ? s.railButtonActive : ''}`}
            onClick={() => setPanelView('info')}
          >
            Node
          </button>
        </nav>

        <aside className={`${s.sidePanel} ${panelView === 'info' ? s.sidePanelInfo : ''}`}>
          {panelView === 'graph' ? (
            <section className={s.panelCard}>
              <div className={s.panelTopRow}>
                <h3 className={s.panelTitle}>Graph Configuration</h3>
                <span className={s.strategyBadge}>{strategyLabel}</span>
              </div>

              <div className={s.configTabs}>
                <button
                  type="button"
                  className={`${s.configTabButton} ${graphConfigView === 'points' ? s.configTabButtonActive : ''}`}
                  onClick={() => setGraphConfigView('points')}
                >
                  Points
                </button>
                <button
                  type="button"
                  className={`${s.configTabButton} ${graphConfigView === 'links' ? s.configTabButtonActive : ''}`}
                  onClick={() => setGraphConfigView('links')}
                >
                  Links
                </button>
              </div>

              {graphConfigView === 'points' ? (
                <>
                  <div className={s.controlStack}>
                    <div className={s.controlGroup}>
                      <label className={s.controlLabel} htmlFor="colorBy">
                        Color by
                      </label>
                      <select
                        id="colorBy"
                        className={s.selectInput}
                        value={colorByKey}
                        onChange={event => setColorByKey(event.target.value)}
                      >
                        {colorOptions.map(option => (
                          <option key={option.key} value={option.key}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className={s.controlGroup}>
                      <label className={s.controlLabel} htmlFor="pointSizeBy">
                        Size
                      </label>
                      <div className={s.sliderRow}>
                        <input
                          id="pointSizeBy"
                          className={s.sliderInput}
                          type="range"
                          min="1"
                          max="10"
                          step="0.1"
                          value={pointSizeScale}
                          onChange={event => setPointSizeScale(Number(event.target.value))}
                        />
                      </div>
                    </div>

                    <div className={s.controlGroup}>
                      <div className={s.toggleRow}>
                        <label className={s.controlLabel} htmlFor="showPointLabels">
                          Show labels
                        </label>
                        <input
                          id="showPointLabels"
                          className={s.toggleInput}
                          type="checkbox"
                          checked={showPointLabels}
                          onChange={event => setShowPointLabels(event.target.checked)}
                        />
                      </div>
                    </div>

                    <div className={s.controlGroup}>
                      <label className={s.controlLabel} htmlFor="pointLabelBy">
                        Label by
                      </label>
                      <select
                        id="pointLabelBy"
                        className={s.selectInput}
                        value={pointLabelByKey}
                        disabled={!showPointLabels}
                        onChange={event => setPointLabelByKey(event.target.value)}
                      >
                        {pointLabelOptions.map(option => (
                          <option key={option.key} value={option.key}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </>
              ) : null}

              {graphConfigView === 'links' ? (
                <div className={s.controlStack}>
                  <div className={s.controlGroup}>
                    <div className={s.toggleRow}>
                      <label className={s.controlLabel} htmlFor="showLinksToggle">
                        Show edges
                      </label>
                      <label className={s.switchControl}>
                        <input
                          id="showLinksToggle"
                          className={s.switchInput}
                          type="checkbox"
                          checked={showLinks}
                          onChange={event => setShowLinks(event.target.checked)}
                        />
                        <span className={s.switchTrack} aria-hidden="true">
                          <span className={s.switchThumb} />
                        </span>
                        <span className={s.switchText}>{showLinks ? 'On' : 'Off'}</span>
                      </label>
                    </div>
                  </div>

                  <div className={s.controlGroup}>
                    <label className={s.controlLabel} htmlFor="linkWidthBy">
                      Edge width
                    </label>
                    <div className={s.sliderRow}>
                      <input
                        id="linkWidthBy"
                        className={s.sliderInput}
                        type="range"
                        min="0.005"
                        max="0.3"
                        step="0.001"
                        value={edgeWidthScale}
                        disabled={!showLinks}
                        onChange={event => setEdgeWidthScale(Number(event.target.value))}
                      />
                    </div>
                  </div>

                  <p className={s.helpText}>Toggle edges and adjust global edge thickness.</p>
                </div>
              ) : null}
            </section>
          ) : null}

          {panelView === 'filters' ? (
            <section className={s.panelCard}>
              <div className={s.panelTopRow}>
                <h3 className={s.panelTitle}>Filter Options</h3>
                <span className={s.strategyBadge}>{activeFilterCount} active</span>
              </div>

              <div className={s.controlStack}>
                <div className={s.filterControls}>
                  <div className={s.controlGroup}>
                    <label className={s.controlLabel} htmlFor="proteinFilter">
                      Protein
                    </label>
                    <select
                      id="proteinFilter"
                      className={s.selectInput}
                      value={proteinFilter}
                      onChange={event => setProteinFilter(event.target.value)}
                    >
                      <option value="all">All proteins</option>
                      {proteinFilterOptions.map(value => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={s.controlGroup}>
                    <label className={s.controlLabel} htmlFor="clusterFilter">
                      Thermodynamics cluster
                    </label>
                    <select
                      id="clusterFilter"
                      className={s.selectInput}
                      value={clusterFilter}
                      onChange={event => setClusterFilter(event.target.value)}
                    >
                      <option value="all">All thermodynamics clusters</option>
                      {clusterFilterOptions.map(value => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={s.controlGroup}>
                    <label className={s.controlLabel} htmlFor="structuralClusterFilter">
                      Structural cluster
                    </label>
                    <select
                      id="structuralClusterFilter"
                      className={s.selectInput}
                      value={structuralClusterFilter}
                      onChange={event => setStructuralClusterFilter(event.target.value)}
                    >
                      <option value="all">All structural clusters</option>
                      {structuralClusterFilterOptions.map(value => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={s.controlGroup}>
                    <label className={s.controlLabel} htmlFor="expMethodFilter">
                      Experimental method
                    </label>
                    <select
                      id="expMethodFilter"
                      className={s.selectInput}
                      value={expMethodFilter}
                      onChange={event => setExpMethodFilter(event.target.value)}
                    >
                      <option value="all">All methods</option>
                      {expMethodFilterOptions.map(value => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={s.controlGroup}>
                    <label className={s.controlLabel} htmlFor="diseaseFilter">
                      Disease
                    </label>
                    <select
                      id="diseaseFilter"
                      className={s.selectInput}
                      value={diseaseFilter}
                      onChange={event => setDiseaseFilter(event.target.value)}
                    >
                      <option value="all">All diseases</option>
                      {diseaseFilterOptions.map(value => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className={s.filterFooter}>
                  <p className={s.filterSummary}>
                    Highlighting {highlightedPointCount} of {data?.points.length ?? 0} nodes
                  </p>
                  <button
                    type="button"
                    className={s.button}
                    disabled={activeFilterCount === 0}
                    onClick={clearFilters}
                  >
                    Clear
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {panelView === 'info' ? (
            <>
              <section className={`${s.panelCard} ${s.selectedNodeCard}`}>
                <div className={s.panelTopRow}>
                  <h3 className={s.panelTitle}>Selected Node</h3>
                  <span className={s.selectedNodeTag}>{selectedPoint?.id ?? 'None selected'}</span>
                </div>
                <div className={s.infoPaneContent}>
                  {selectedPoint ? (
                    <dl className={s.infoList}>
                      {selectedPointEntries.map(entry => (
                        <div key={entry.key} className={s.infoRow}>
                          <dt>{entry.label}</dt>
                          <dd>{entry.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className={s.helpText}>Select a node to inspect key metadata fields.</p>
                  )}
                </div>
              </section>

              <section className={`${s.panelCard} ${s.proteinCard}`}>
                <div className={s.panelTopRow}>
                  <h3 className={s.panelTitle}>Protein 3D (Molstar)</h3>
                  <div className={s.panelActions}>
                    <button
                      type="button"
                      className={s.button}
                      onClick={() => setIsMolstarExpanded(prev => !prev)}
                    >
                      {isMolstarExpanded ? 'Shrink' : 'Expand'}
                    </button>
                    <span className={s.strategyBadge}>{loadedProteinLabel}</span>
                  </div>
                </div>

                {isMolstarExpanded ? (
                  <button
                    type="button"
                    className={s.molstarBackdrop}
                    aria-label="Close expanded protein viewer"
                    onClick={() => setIsMolstarExpanded(false)}
                  />
                ) : null}

                <div className={s.infoPaneContent}>
                  <div className={`${s.molstarShell} ${isMolstarExpanded ? s.molstarShellExpanded : ''}`}>
                    {isMolstarExpanded ? (
                      <button
                        type="button"
                        className={s.molstarCloseButton}
                        aria-label="Close expanded protein viewer"
                        onClick={() => setIsMolstarExpanded(false)}
                      >
                        Close
                      </button>
                    ) : null}

                    <div id={MOLSTAR_TARGET_ID} className={s.molstarViewport} />
                    {isProteinLoading ? <div className={s.molstarOverlay}>Loading structure...</div> : null}
                    {!isProteinLoading && !selectedPoint ? (
                      <div className={s.molstarOverlay}>Select a node to load its protein structure.</div>
                    ) : null}
                    {isMolstarExpanded && proteinColorByBFactor ? (
                      <div
                        className={`${s.energyLegendCard} ${s.energyLegendCardFloating}`}
                        role="group"
                        aria-label="Protein energy color legend"
                      >
                        <div className={s.energyLegendHeaderRow}>
                          <p className={s.energyLegendTitle}>Residue-level &Delta;G</p>
                        </div>

                        <div
                          className={`${s.energyLegendGradient} ${hasEnergyLegend ? '' : s.energyLegendGradientDisabled}`}
                          aria-hidden="true"
                        />

                        <div className={s.energyLegendTicks}>
                          <span>{hasEnergyLegend && energyLegendMin !== null ? formatEnergyValue(energyLegendMin) : 'low'}</span>
                          <span>0</span>
                          <span>{hasEnergyLegend && energyLegendMax !== null ? formatEnergyValue(energyLegendMax) : 'high'}</span>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className={s.toggleRow}>
                    <label className={s.controlLabel} htmlFor="proteinColorByBFactor">
                      Color by Energy Profile (PDB)
                    </label>
                    <label className={s.switchControl} htmlFor="proteinColorByBFactor">
                      <input
                        id="proteinColorByBFactor"
                        className={s.switchInput}
                        type="checkbox"
                        checked={proteinColorByBFactor}
                        onChange={event => setProteinColorByBFactor(event.target.checked)}
                      />
                      <span className={s.switchTrack} aria-hidden="true">
                        <span className={s.switchThumb} />
                      </span>
                      <span className={s.switchText}>{proteinColorByBFactor ? 'On' : 'Off'}</span>
                    </label>
                  </div>

                  <p className={s.helpText}>
                    {selectedPoint
                      ? `Toggle coloring the structure by the energy profile from the PDB file.`
                      : 'No structure is loaded until a node is selected.'}
                  </p>

                  {proteinColorByBFactor ? (
                    <div className={s.energyLegendCard} role="group" aria-label="Protein energy color legend">
                      <div className={s.energyLegendHeaderRow}>
                        <p className={s.energyLegendTitle}>Residue-level &Delta;G</p>
                      </div>

                      <div
                        className={`${s.energyLegendGradient} ${hasEnergyLegend ? '' : s.energyLegendGradientDisabled}`}
                        aria-hidden="true"
                      />

                      <div className={s.energyLegendTicks}>
                        <span>{hasEnergyLegend && energyLegendMin !== null ? formatEnergyValue(energyLegendMin) : 'low'}</span>
                        <span>0</span>
                        <span>{hasEnergyLegend && energyLegendMax !== null ? formatEnergyValue(energyLegendMax) : 'high'}</span>
                      </div>
                    </div>
                  ) : null}

                  {proteinError ? <div className={s.error}>{proteinError}</div> : null}
                </div>
              </section>
            </>
          ) : null}

          {error ? <div className={s.error}>{error}</div> : null}
        </aside>

        <section className={s.visualizationShell}>
          <header className={s.canvasHeader}>
            <div>
              <h2 className={s.canvasTitle}>Amyloid Structure Network</h2>
              <p className={s.canvasSubtitle}>
                {currentDataset.points.length} nodes, {currentDataset.links.length} edges
                {activeFilterCount > 0 ? `, ${highlightedPointCount} highlighted` : ''}
              </p>
            </div>
            <div className={s.headerMeta}>
              <span className={s.metaChip}>Color field: {selectedColorOption?.label ?? 'N/A'}</span>
            </div>
          </header>

          <div className={s.visualizationContainer}>
            <div className={s.graphCanvasArea}>
              <div className={s.selectedNodeOverlay} aria-live="polite">
                <p className={s.selectedNodeOverlayLabel}>Selected node</p>
                <p className={s.selectedNodeOverlayValue}>{selectedPoint?.id ?? 'None selected'}</p>
                <button
                  type="button"
                  className={s.button}
                  disabled={!selectedPointDatabaseUrl}
                  onClick={openSelectedPointDatabasePage}
                >
                  Open selected node page
                </button>
                <button
                  type="button"
                  className={s.button}
                  disabled={!selectedThermodynamicsImageUrl}
                  onClick={openThermodynamicsClusterModal}
                >
                  View cluster alignment
                </button>
              </div>

              <div ref={searchOverlayRef} className={s.searchOverlay}>
                <CosmographSearch
                  ref={search}
                  className={s.searchInput}
                  placeholderText="Search across all node fields"
                  suggestionFields={initialSuggestionFields}
                  onSelect={handleSearchSelect}
                  onClear={() => {
                    setSelectedPoint(null)
                    cosmograph.current?.unselectAllPoints()
                  }}
                  showFooter={true}
                  showAccessorsMenu={true}
                />
              </div>

              {typeLegendState.show ? (
                <div className={s.graphLegendOverlay}>
                  <CosmographTypeColorLegend
                    className={s.graphLegend}
                    showLabel={true}
                    labelResolver={typeLegendState.label}
                    sortBy={typeLegendState.sortBy}
                    sortOrder="asc"
                    hideUnknown={false}
                    selectOnClick={true}
                    maxDisplayedItems={12}
                  />
                </div>
              ) : null}

              {hasGraphData ? (
              <Cosmograph
                ref={cosmograph}
                onMount={handleGraphMount}
                points={currentDataset.points ?? []}
                links={currentDataset.links ?? []}
                pointIdBy="id"
                pointIndexBy="idx"
                pointLabelBy={pointLabelByKey}
                showLabels={showPointLabels}
                pointLabelClassName={shouldGreyAllPoints ? s.dimmedGraphLabel : undefined}
                hoveredPointLabelClassName={shouldGreyAllPoints ? s.dimmedGraphLabel : undefined}
                pointColorBy={pointColorConfig.pointColorBy}
                pointColorStrategy={pointColorConfig.pointColorStrategy}
                pointColorByMap={pointColorConfig.pointColorByMap}
                pointGreyoutColor="#b0b9c6"
                pointGreyoutOpacity={0.15}
                pointOpacity={shouldGreyAllPoints ? 0.15 : 1}
                backgroundColor="#ffffff"
                pointSizeBy="node_size"
                pointSizeScale={pointSizeScale}
                randomSeed={42}
                simulationGravity={1}
                simulationRepulsion={10}
                simulationRepulsionTheta={1.15}
                simulationLinkSpring={0.5}
                simulationLinkDistance={10}
                simulationFriction={0.85}
                linkSourceBy="source"
                linkTargetBy="target"
                linkSourceIndexBy="sourceidx"
                linkTargetIndexBy="targetidx"
                linkWidthBy="value"
                linkWidthScale={showLinks ? edgeWidthScale : 0}
                linkGreyoutOpacity={0.06}
                linkOpacity={shouldGreyAllPoints ? 0.06 : 1}
                simulationDecay={100}
                fitViewOnInit={false}
                scalePointsOnZoom={true}
                scaleLinksOnZoom={true}
                selectPointOnClick={true}
                onClick={handleGraphClick}
                style={{ width: '100%', height: '100%' }}
              />
              ) : null}
              {isLoading ? <div className={s.loadingOverlay}>Loading data…</div> : null}
              {!isLoading && !error && !hasGraphData ? (
                <div className={s.loadingOverlay}>No nodes available in the current dataset.</div>
              ) : null}
            </div>

            {isClusterModalOpen ? (
              <section
                className={s.clusterPreviewPane}
                role="region"
                aria-label="Thermodynamics cluster dendrogram"
              >
                <div className={s.clusterPreviewHeader}>
                  <h3 className={s.clusterPreviewTitle}>
                    {selectedThermodynamicsCluster === null
                      ? 'Thermodynamics cluster'
                      : `Thermodynamics cluster ${selectedThermodynamicsCluster}`}
                  </h3>
                  <div className={s.clusterPreviewActions}>
                    <button
                      type="button"
                      className={s.button}
                      disabled={!selectedThermodynamicsImageUrl || clusterImageHasError}
                      onClick={openThermodynamicsClusterFullscreen}
                    >
                      Fullscreen
                    </button>
                    <button
                      type="button"
                      className={s.button}
                      onClick={closeThermodynamicsClusterModal}
                    >
                      Close
                    </button>
                  </div>
                </div>

                {selectedThermodynamicsImageUrl && !clusterImageHasError ? (
                  <div className={s.clusterPreviewScrollArea}>
                    <img
                      className={s.clusterPreviewImage}
                      src={selectedThermodynamicsImageUrl}
                      alt={`Dendrogram for thermodynamics cluster ${selectedThermodynamicsCluster ?? 'unknown'}`}
                      onError={() => setClusterImageHasError(true)}
                    />
                  </div>
                ) : (
                  <p className={s.clusterPreviewMessage}>
                    {selectedThermodynamicsImageName
                      ? `No dendrogram image found. Expected data/${selectedThermodynamicsImageName}.`
                      : 'Select a node with a valid thermodynamics cluster value.'}
                  </p>
                )}
              </section>
            ) : null}

            {isClusterImageExpanded && selectedThermodynamicsImageUrl && !clusterImageHasError ? (
              <section
                className={s.clusterPreviewFullscreenBackdrop}
                role="dialog"
                aria-modal="true"
                aria-label="Thermodynamics cluster dendrogram fullscreen preview"
              >
                <div className={s.clusterPreviewFullscreenCard}>
                  <div className={s.clusterPreviewHeader}>
                    <h3 className={s.clusterPreviewTitle}>
                      {selectedThermodynamicsCluster === null
                        ? 'Thermodynamics cluster'
                        : `Thermodynamics cluster ${selectedThermodynamicsCluster}`}
                    </h3>
                    <button
                      type="button"
                      className={s.button}
                      onClick={closeThermodynamicsClusterFullscreen}
                    >
                      Close fullscreen
                    </button>
                  </div>

                  <div className={`${s.clusterPreviewScrollArea} ${s.clusterPreviewScrollAreaFullscreen}`}>
                    <img
                      className={s.clusterPreviewImage}
                      src={selectedThermodynamicsImageUrl}
                      alt={`Dendrogram for thermodynamics cluster ${selectedThermodynamicsCluster ?? 'unknown'}`}
                      onError={() => {
                        setClusterImageHasError(true)
                        setIsClusterImageExpanded(false)
                      }}
                    />
                  </div>
                </div>
              </section>
            ) : null}
          </div>
        </section>
      </div>
    </CosmographProvider>
  )
}

const rootElement = document.getElementById('root')
if (rootElement) {
  createRoot(rootElement).render(
    React.createElement(component)
  )
}
