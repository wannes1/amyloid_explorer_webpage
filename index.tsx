import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import {
  CosmographProvider,
  Cosmograph,
  CosmographRef,
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
  cluster_seq: number
  cluster: number
  Protein?: string
  cluster_color_thermodynamics?: string
  cluster_color?: string
  cluster_color_seq?: string
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

type PanelView = 'graph' | 'filters' | 'info'
type GraphConfigView = 'points' | 'links'

const MOLSTAR_TARGET_ID = 'molstar-viewer-root'
const TEST_SELECTED_NODE_URL = 'https://amyloid-explorer.switchlab.org/database/Abeta42?strct=8KEW'

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
  const [edgeWidthScale, setEdgeWidthScale] = useState(1)
  const [isProteinLoading, setIsProteinLoading] = useState(false)
  const [proteinError, setProteinError] = useState<string | null>(null)
  const [loadedProteinLabel, setLoadedProteinLabel] = useState('No node selected')
  const [isMolstarReady, setIsMolstarReady] = useState(false)
  const [isMolstarExpanded, setIsMolstarExpanded] = useState(false)
  const [proteinColorByBFactor, setProteinColorByBFactor] = useState(true)
  const [proteinFilter, setProteinFilter] = useState('all')
  const [clusterFilter, setClusterFilter] = useState('all')
  const [clusterSeqFilter, setClusterSeqFilter] = useState('all')
  const [isClusterModalOpen, setIsClusterModalOpen] = useState(false)
  const [clusterImageHasError, setClusterImageHasError] = useState(false)

  const cosmograph = useRef<CosmographRef | null>(null)
  const molstarViewerRef = useRef<MolstarViewerInstance | null>(null)

  const buildColorOptions = useCallback((sample: CsvRow): PointColorOption[] => {
    const options: PointColorOption[] = []

    const addOption = (option: PointColorOption) => {
      if (sample[option.key] !== undefined) {
        options.push(option)
      }
    }

    addOption({
      key: 'cluster_thermodynamics',
      label: 'Thermodynamics cluster',
      strategy: 'continuous',
      description: 'Continuous gradient using cluster_thermodynamics values.',
    })
    addOption({
      key: 'cluster_seq',
      label: 'Sequence cluster',
      strategy: 'continuous',
      description: 'Continuous gradient using cluster_seq values.',
    })
    addOption({
      key: 'cluster',
      label: 'Cluster',
      strategy: 'categorical',
      description: 'Categorical palette assigning discrete colors per cluster value.',
    })
    addOption({
      key: 'Protein',
      label: 'Protein',
      strategy: 'categorical',
      description: 'Categorical palette assigning a distinct color to each protein.',
    })
    addOption({
      key: 'cluster_color',
      label: 'Cluster color field',
      strategy: 'direct',
      description: 'Use hex colors directly from cluster_color.',
    })
    addOption({
      key: 'cluster_color_thermodynamics',
      label: 'Thermodynamics color field',
      strategy: 'direct',
      description: 'Use hex colors directly from cluster_color_thermodynamics.',
    })
    addOption({
      key: 'cluster_color_seq',
      label: 'Sequence color field',
      strategy: 'direct',
      description: 'Use hex colors directly from cluster_color_seq.',
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

  const parseUncertaintyDomainFromPdb = useCallback((pdbText: string): [number, number] | null => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY

    for (const line of pdbText.split(/\r?\n/)) {
      if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) {
        continue
      }

      // PDB B-factor/uncertainty is in columns 61-66 (1-based indexing).
      const raw = line.slice(60, 66).trim()
      const value = Number(raw)

      if (!Number.isFinite(value)) {
        continue
      }

      if (value < min) min = value
      if (value > max) max = value
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return null
    }

    if (min === max) {
      const delta = min === 0 ? 1 : Math.abs(min) * 0.1
      return [min - delta, max + delta]
    }

    return [min, max]
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
        fetch('/data/nodes.csv'),
        fetch('/data/edges.csv'),
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
        const clusterSeqRaw = row.cluster_seq
        const clusterSeq = toNumber(clusterSeqRaw)
        const cluster = toNumber(row.cluster)
        const pointIndex = toIndex(idx) ?? 0
        return {
          ...row,
          id,
          idx: pointIndex,
          cluster_thermodynamics: clusterThermo,
          cluster_seq: clusterSeq,
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
            value: toNumber(row.weight ?? row.best_score),
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
      const value = point.cluster
      values.add(value === undefined ? 'Unknown' : String(value))
    })

    return Array.from(values).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    )
  }, [data])

  const clusterSeqFilterOptions = useMemo(() => {
    if (!data) return []

    const values = new Set<string>()
    data.points.forEach(point => {
      const value = point.cluster_seq
      values.add(value === undefined ? 'Unknown' : String(value))
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

    if (clusterSeqFilter !== 'all' && !clusterSeqFilterOptions.includes(clusterSeqFilter)) {
      setClusterSeqFilter('all')
    }
  }, [
    clusterFilter,
    clusterFilterOptions,
    clusterSeqFilter,
    clusterSeqFilterOptions,
    proteinFilter,
    proteinFilterOptions,
  ])

  const currentDataset = useMemo<GraphDataset>(() => {
    if (!data) {
      return { points: [], links: [] }
    }

    const filteredPoints = data.points.filter(point => {
      const proteinValue = point.Protein === undefined || point.Protein === '' ? 'Unknown' : String(point.Protein)
      const clusterValue = point.cluster === undefined ? 'Unknown' : String(point.cluster)
      const clusterSeqValue =
        point.cluster_seq === undefined ? 'Unknown' : String(point.cluster_seq)

      if (proteinFilter !== 'all' && proteinValue !== proteinFilter) return false
      if (clusterFilter !== 'all' && clusterValue !== clusterFilter) return false
      if (clusterSeqFilter !== 'all' && clusterSeqValue !== clusterSeqFilter) return false

      return true
    })

    const points = filteredPoints.map((point, idx) => ({
      ...point,
      idx: toIndex(idx) ?? 0,
    }))

    const pointIndexById = new Map(points.map(point => [point.id, point.idx]))
    const links = data.links
      .filter(link => pointIndexById.has(link.source) && pointIndexById.has(link.target))
      .map(link => ({
        ...link,
        sourceidx: toIndex(pointIndexById.get(link.source)) ?? 0,
        targetidx: toIndex(pointIndexById.get(link.target)) ?? 0,
      }))

    return { points, links }
  }, [clusterFilter, clusterSeqFilter, data, proteinFilter, toIndex])

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

  const pointLabelOptions = useMemo(() => {
    const values = new Set<string>(['id', 'Protein'])
    currentDataset.points.slice(0, 80).forEach(point => {
      Object.entries(point).forEach(([key, value]) => {
        if (typeof value === 'string' || typeof value === 'number') {
          values.add(key)
        }
      })
    })

    return Array.from(values).map(key => ({ key, label: key }))
  }, [currentDataset.points])

  useEffect(() => {
    if (!pointLabelOptions.some(option => option.key === pointLabelByKey)) {
      setPointLabelByKey(pointLabelOptions[0]?.key ?? 'Protein')
    }
  }, [pointLabelByKey, pointLabelOptions])

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

  const selectedPointEntries = useMemo(() => {
    if (!selectedPoint) return []

    const preferredOrder = [
      'id',
      'Protein',
      'cluster_thermodynamics',
      'cluster_seq',
      'cluster',
      'cluster_color_thermodynamics',
      'cluster_color_seq',
      'cluster_color',
    ]

    const seen = new Set<string>()
    const entries: Array<[string, string | number]> = []

    preferredOrder.forEach(key => {
      const value = selectedPoint[key]
      if (value !== undefined && value !== '') {
        entries.push([key, value])
        seen.add(key)
      }
    })

    Object.entries(selectedPoint).forEach(([key, value]) => {
      if (seen.has(key)) return
      if (value === undefined || value === '') return
      entries.push([key, value])
    })

    return entries
  }, [selectedPoint])

  const selectedPointDatabaseUrl = TEST_SELECTED_NODE_URL

  const selectedThermodynamicsCluster = useMemo(() => {
    if (!selectedPoint) return null

    const rawValue = selectedPoint.cluster_thermodynamics
    const numericValue = Number(rawValue)
    if (!Number.isFinite(numericValue)) return null

    return Math.trunc(numericValue)
  }, [selectedPoint])

  const selectedThermodynamicsImageName = useMemo(() => {
    if (selectedThermodynamicsCluster === null) return null
    return `thermodynamics_cluster_${selectedThermodynamicsCluster}_msa_dendrogram.png`
  }, [selectedThermodynamicsCluster])

  const selectedThermodynamicsImageUrl = useMemo(() => {
    if (!selectedThermodynamicsImageName) return null
    return `/data/${selectedThermodynamicsImageName}`
  }, [selectedThermodynamicsImageName])

  const openThermodynamicsClusterModal = useCallback(() => {
    if (!selectedThermodynamicsImageUrl) return
    setClusterImageHasError(false)
    setIsClusterModalOpen(true)
  }, [selectedThermodynamicsImageUrl])

  const closeThermodynamicsClusterModal = useCallback(() => {
    setIsClusterModalOpen(false)
  }, [])

  const openSelectedPointDatabasePage = useCallback(() => {
    if (!selectedPointDatabaseUrl) return
    window.open(selectedPointDatabaseUrl, '_blank', 'noopener,noreferrer')
  }, [selectedPointDatabaseUrl])

  useEffect(() => {
    if (!isClusterModalOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsClusterModalOpen(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isClusterModalOpen])

  useEffect(() => {
    setClusterImageHasError(false)
  }, [selectedThermodynamicsImageUrl])

  useEffect(() => {
    if (!selectedPoint) {
      setIsClusterModalOpen(false)
    }
  }, [selectedPoint])

  const strategyLabel = useMemo(() => {
    if (!selectedColorOption) return 'N/A'
    if (selectedColorOption.strategy === 'categorical') return 'Categorical'
    if (selectedColorOption.strategy === 'continuous') return 'Continuous'
    return 'Direct'
  }, [selectedColorOption])

  const activeFilterCount = useMemo(() => {
    return [proteinFilter, clusterFilter, clusterSeqFilter].filter(value => value !== 'all').length
  }, [clusterFilter, clusterSeqFilter, proteinFilter])

  const clearFilters = useCallback(() => {
    setProteinFilter('all')
    setClusterFilter('all')
    setClusterSeqFilter('all')
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
        }
      }

      void clearViewer()

      return () => {
        cancelled = true
      }
    }

    const nodeFileUrl = `/data/${encodeURIComponent(selectedId)}.pdb`
    const urlsToTry = nodeFileUrl !== '/data/test.pdb'
      ? [nodeFileUrl, '/data/test.pdb']
      : ['/data/test.pdb']

    const loadStructure = async () => {
      setIsProteinLoading(true)
      setProteinError(null)

      let lastError: unknown = null
      let resolvedUrl: string | null = null
      let resolvedPdbText: string | null = null

      for (const url of urlsToTry) {
        try {
          const absoluteUrl = new URL(url, window.location.href).toString()
          const res = await fetch(absoluteUrl)
          if (res.ok) {
            resolvedUrl = url
            resolvedPdbText = await res.text()
            break
          }
        } catch (err) {
          lastError = err
        }
      }

      if (!resolvedUrl) {
        if (!cancelled) {
          const message =
            lastError instanceof Error
              ? lastError.message
              : `No structure file found for ${selectedId}. Expected /data/${selectedId}.pdb or /data/test.pdb.`
          setProteinError(message)
          setIsProteinLoading(false)
          setLoadedProteinLabel('Missing structure')
        }
        return
      }

      try {
        if (viewer.plugin?.clear) {
          await viewer.plugin.clear()
        }

        const absoluteResolvedUrl = new URL(resolvedUrl, window.location.href).toString()
        const uncertaintyDomain = resolvedPdbText
          ? parseUncertaintyDomainFromPdb(resolvedPdbText)
          : null

        if (proteinColorByBFactor) {
          try {
            await Promise.resolve(
              viewer.loadStructureFromUrl(absoluteResolvedUrl, 'pdb', false, {
                representationParams: {
                  // Use Molstar's B-factor/uncertainty theme with a custom color scale.
                  theme: {
                    globalName: 'uncertainty',
                    globalColorParams: {
                      domain: uncertaintyDomain ?? [0, 1],
                      list: {
                        kind: 'interpolate',
                        colors: [
                          0xff0000, // red (high)
                          0xDDDDDD, // light grey (mid)
                          0x0000ff, // blue (low)
                        ],
                      },
                    },
                  },
                },
              })
            )
          } catch {
            // Fallback to the default preset if the B-factor theme isn't available for this file.
            await Promise.resolve(viewer.loadStructureFromUrl(absoluteResolvedUrl, 'pdb', false))
          }
        } else {
          await Promise.resolve(viewer.loadStructureFromUrl(absoluteResolvedUrl, 'pdb', false))
        }

        if (!cancelled) {
          setLoadedProteinLabel(resolvedUrl.split('/').pop() ?? 'test.pdb')
          setIsProteinLoading(false)
        }

        return
      } catch (err) {
        lastError = err
      }

      if (!cancelled) {
        const message = lastError instanceof Error ? lastError.message : 'Failed to load structure file.'
        setProteinError(message)
        setIsProteinLoading(false)
      }
    }

    void loadStructure()

    return () => {
      cancelled = true
    }
  }, [isMolstarReady, panelView, parseUncertaintyDomainFromPdb, proteinColorByBFactor, selectedPoint?.id])

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

        <aside className={s.sidePanel}>
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

                  <p className={s.helpText}>
                    {selectedColorOption?.description ?? 'No color fields detected in nodes.csv.'}
                  </p>
                </>
              ) : null}

              {graphConfigView === 'links' ? (
                <>
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

                  <label className={s.controlLabel} htmlFor="linkWidthBy">
                    Edge width
                  </label>
                  <div className={s.sliderRow}>
                    <input
                      id="linkWidthBy"
                      className={s.sliderInput}
                      type="range"
                      min="0.4"
                      max="3"
                      step="0.1"
                      value={edgeWidthScale}
                      disabled={!showLinks}
                      onChange={event => setEdgeWidthScale(Number(event.target.value))}
                    />
                    <span className={s.sliderValue}>{edgeWidthScale.toFixed(1)}x</span>
                  </div>

                  <p className={s.helpText}>Toggle edges and adjust global edge thickness.</p>
                </>
              ) : null}
            </section>
          ) : null}

          {panelView === 'filters' ? (
            <section className={s.panelCard}>
              <div className={s.panelTopRow}>
                <h3 className={s.panelTitle}>Filter Options</h3>
                <span className={s.strategyBadge}>{activeFilterCount} active</span>
              </div>

              <div className={s.filterControls}>
                <div>
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

                <div>
                  <label className={s.controlLabel} htmlFor="clusterFilter">
                    Cluster
                  </label>
                  <select
                    id="clusterFilter"
                    className={s.selectInput}
                    value={clusterFilter}
                    onChange={event => setClusterFilter(event.target.value)}
                  >
                    <option value="all">All clusters</option>
                    {clusterFilterOptions.map(value => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={s.controlLabel} htmlFor="clusterSeqFilter">
                    Cluster Seq
                  </label>
                  <select
                    id="clusterSeqFilter"
                    className={s.selectInput}
                    value={clusterSeqFilter}
                    onChange={event => setClusterSeqFilter(event.target.value)}
                  >
                    <option value="all">All sequence clusters</option>
                    {clusterSeqFilterOptions.map(value => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className={s.filterFooter}>
                <p className={s.filterSummary}>
                  Showing {currentDataset.points.length} of {data?.points.length ?? 0} nodes
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
            </section>
          ) : null}

          {panelView === 'info' ? (
            <>
              <section className={s.panelCard}>
                <div className={s.panelTopRow}>
                  <h3 className={s.panelTitle}>Selected Node</h3>
                  <span className={s.selectedNodeTag}>{selectedPoint?.id ?? 'None selected'}</span>
                </div>
                {selectedPoint ? (
                  <dl className={s.infoList}>
                    {selectedPointEntries.map(([key, value]) => (
                      <div key={key} className={s.infoRow}>
                        <dt>{key}</dt>
                        <dd>{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className={s.helpText}>Select a node to inspect all node fields from nodes.csv.</p>
                )}
              </section>

              <section className={s.panelCard}>
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
                    ? `File source: /data/${selectedPoint.id}.pdb with fallback to /data/test.pdb.`
                    : 'No structure is loaded until a node is selected.'}
                </p>

                {proteinError ? <div className={s.error}>{proteinError}</div> : null}
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
              </p>
            </div>
            <div className={s.headerMeta}>
              <span className={s.metaChip}>Color field: {selectedColorOption?.label ?? 'N/A'}</span>
              <span className={s.metaChip}>Mode: {strategyLabel}</span>
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
              {hasGraphData ? (
              <Cosmograph
                ref={cosmograph}
                points={currentDataset.points ?? []}
                links={currentDataset.links ?? []}
                pointIdBy="id"
                pointIndexBy="idx"
                pointLabelBy={pointLabelByKey}
                showLabels={showPointLabels}
                pointColorBy={selectedColorOption?.key || 'id'}
                backgroundColor="#eeeeee"
                pointSizeBy="node_size"
                pointSizeScale={pointSizeScale}
                pointClusterBy="cluster_thermodynamics"
                randomSeed={42}
                simulationGravity={1}
                simulationRepulsion={10}
                simulationLinkSpring={1}
                simulationLinkDistance={10}
                simulationFriction={0.85}
                simulationCluster={1}
                linkSourceBy="source"
                linkTargetBy="target"
                linkSourceIndexBy="sourceidx"
                linkTargetIndexBy="targetidx"
                linkWidthBy="value"
                linkWidthScale={showLinks ? edgeWidthScale : 0}
                simulationDecay={100}
                fitViewDelay={400}
                initialZoomLevel={1.2}
                scalePointsOnZoom={true}
                scaleLinksOnZoom={true}
                selectPointOnClick={true}
                onClick={handleGraphClick}
                style={{ width: '100%', height: '100%' }}
              />
              ) : null}
              {isLoading ? <div className={s.loadingOverlay}>Loading data…</div> : null}
              {!isLoading && !error && !hasGraphData ? (
                <div className={s.loadingOverlay}>No nodes available for the current filter selection.</div>
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
                  <button
                    type="button"
                    className={s.button}
                    onClick={closeThermodynamicsClusterModal}
                  >
                    Close
                  </button>
                </div>

                {selectedThermodynamicsImageUrl && !clusterImageHasError ? (
                  <img
                    className={s.clusterPreviewImage}
                    src={selectedThermodynamicsImageUrl}
                    alt={`Dendrogram for thermodynamics cluster ${selectedThermodynamicsCluster ?? 'unknown'}`}
                    onError={() => setClusterImageHasError(true)}
                  />
                ) : (
                  <p className={s.clusterPreviewMessage}>
                    {selectedThermodynamicsImageName
                      ? `No dendrogram image found. Expected /data/${selectedThermodynamicsImageName}.`
                      : 'Select a node with a valid thermodynamics cluster value.'}
                  </p>
                )}
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
