import * as React from 'react'
import { Repository } from '../../models/repository'
import {
  ITextDiff,
  DiffLineType,
  DiffHunk,
  DiffLine,
  DiffSelection,
} from '../../models/diff'
import {
  getLineFilters,
  getFileContents,
  highlightContents,
} from './syntax-highlighting'
import { ITokens } from '../../lib/highlighter/types'
import {
  assertNever,
  assertNonNullable,
  forceUnwrap,
} from '../../lib/fatal-error'
import classNames from 'classnames'
import {
  List,
  AutoSizer,
  CellMeasurerCache,
  CellMeasurer,
  ListRowProps,
} from 'react-virtualized'
import { SideBySideDiffRow } from './side-by-side-diff-row'
import memoize from 'memoize-one'
import { findInteractiveDiffRange } from './diff-explorer'
import {
  ChangedFile,
  DiffRow,
  DiffRowType,
  IDiffRowData,
  isInTemporarySelection,
  canSelect,
  ISelection,
} from './diff-helpers'
import { showContextualMenu } from '../main-process-proxy'
import { WorkingDirectoryFileChange } from '../../models/status'

const DefaultRowHeight = 20

interface ISideBySideDiffProps {
  readonly repository: Repository
  /** The file whose diff should be displayed. */
  readonly file: ChangedFile
  /** The diff that should be rendered */
  readonly diff: ITextDiff

  /**
   * Called when the includedness of lines or a range of lines has changed.
   * Only applicable when readOnly is false.
   */
  readonly onIncludeChanged?: (diffSelection: DiffSelection) => void

  /**
   * Called when the user wants to discard a selection of the diff.
   * Only applicable when readOnly is false.
   */
  readonly onDiscardChanges?: (
    diff: ITextDiff,
    diffSelection: DiffSelection
  ) => void

  /**
   * Whether we'll show a confirmation dialog when the user
   * discards changes.
   */
  readonly askForConfirmationOnDiscardChanges?: boolean
}

interface ISideBySideDiffState {
  readonly beforeTokens?: ITokens
  readonly afterTokens?: ITokens
  readonly selectingRow?: 'before' | 'after'
  readonly selection?: ISelection

  /** Whether a particular range should be highlighted due to hover */
  readonly hoveredHunk?: number
}

const cache = new CellMeasurerCache({
  defaultHeight: DefaultRowHeight,
  fixedWidth: true,
})

export class SideBySideDiff extends React.Component<
  ISideBySideDiffProps,
  ISideBySideDiffState
> {
  public constructor(props: ISideBySideDiffProps) {
    super(props)

    this.state = {}
  }

  public componentDidMount() {
    this.initDiffSyntaxMode()
  }

  public componentDidUpdate(prevProps: ISideBySideDiffProps) {
    if (!highlightParametersEqual(this.props, prevProps)) {
      this.initDiffSyntaxMode()
    }
  }

  public render() {
    return (
      <div
        className={classNames([
          {
            'side-by-side-diff-container': true,
            [`selecting-${this.state.selectingRow}`]:
              this.state.selectingRow !== undefined,
            editable: canSelect(this.props.file),
          },
        ])}
        onMouseDown={this.onMouseDown}
      >
        <div className="side-by-side-diff cm-s-default">
          <AutoSizer onResize={this.clearCache}>
            {({ height, width }) => (
              <List
                deferredMeasurementCache={cache}
                width={width}
                height={height}
                rowCount={
                  getDiffRows(
                    this.props.diff,
                    this.props.file,
                    this.state.selection
                  ).length
                }
                rowHeight={this.getRowHeight}
                rowRenderer={this.renderRow}
                // Passing them to force re-renders when tokens change.
                beforeTokens={this.state.beforeTokens}
                afterTokens={this.state.afterTokens}
                temporarySelection={this.state.selection}
                hoveredHunk={this.state.hoveredHunk}
                fileId={this.props.file.id}
                fileSelection={
                  canSelect(this.props.file) && this.props.file.selection
                }
              />
            )}
          </AutoSizer>
        </div>
      </div>
    )
  }

  private renderRow = ({ index, parent, style, key }: ListRowProps) => {
    const rows = getDiffRows(
      this.props.diff,
      this.props.file,
      this.state.selection
    )
    const row = rows[index]

    if (row === undefined) {
      return null
    }

    return (
      <CellMeasurer
        cache={cache}
        columnIndex={0}
        key={key}
        overscanRowCount={10}
        parent={parent}
        rowIndex={index}
      >
        <div key={key} style={style}>
          <SideBySideDiffRow
            row={row}
            beforeTokens={this.state.beforeTokens}
            afterTokens={this.state.afterTokens}
            file={this.props.file}
            isHunkHovered={this.state.hoveredHunk === row.hunkStartLine}
            onStartSelection={this.onStartSelection}
            onUpdateSelection={this.onUpdateSelection}
            onMouseEnterHunk={this.onMouseEnterHunk}
            onMouseLeaveHunk={this.onMouseLeaveHunk}
            onClickHunk={this.onClickHunk}
            onContextMenuLine={this.onContextMenuLine}
            onContextMenuHunk={this.onContextMenuHunk}
          />
        </div>
      </CellMeasurer>
    )
  }

  private getRowHeight = (row: { index: number }) => {
    return cache.rowHeight(row) ?? DefaultRowHeight
  }

  private clearCache = () => {
    cache.clearAll()
  }

  private onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLDivElement

    const isSelectingBeforeText = target.closest('.before')
    const isSelectingAfterText = target.closest('.after')

    if (isSelectingBeforeText !== null) {
      this.setState({ selectingRow: 'before' })
    } else if (isSelectingAfterText !== null) {
      this.setState({ selectingRow: 'after' })
    }
  }

  private async initDiffSyntaxMode() {
    const { file, diff, repository } = this.props

    // Store the current props to that we can see if anything
    // changes from underneath us as we're making asynchronous
    // operations that makes our data stale or useless.
    const propsSnapshot = this.props

    const lineFilters = getLineFilters(diff.hunks)
    const tabSize = 4

    const contents = await getFileContents(repository, file, lineFilters)

    if (!highlightParametersEqual(this.props, propsSnapshot)) {
      return
    }

    const tokens = await highlightContents(contents, tabSize, lineFilters)

    if (!highlightParametersEqual(this.props, propsSnapshot)) {
      return
    }

    this.setState({
      beforeTokens: tokens.oldTokens,
      afterTokens: tokens.newTokens,
    })
  }

  private onStartSelection = (lineNumber: number, select: boolean) => {
    this.setState({
      selection: {
        from: lineNumber,
        to: lineNumber,
        isSelected: select,
      },
    })

    document.addEventListener('mouseup', this.onEndSelection, { once: true })
  }

  private onEndSelection = () => {
    if (!canSelect(this.props.file)) {
      return
    }

    if (this.state.selection === undefined) {
      return
    }

    if (this.props.onIncludeChanged === undefined) {
      return
    }

    const from = Math.min(this.state.selection.from, this.state.selection.to)
    const to = Math.max(this.state.selection.from, this.state.selection.to)

    this.props.onIncludeChanged(
      this.props.file.selection.withRangeSelection(
        from,
        to - from + 1,
        this.state.selection.isSelected
      )
    )

    this.setState({
      selection: undefined,
    })
  }

  private onUpdateSelection = (lineNumber: number) => {
    if (this.state.selection === undefined) {
      return
    }

    this.setState({
      selection: {
        ...this.state.selection,
        to: lineNumber,
      },
    })
  }

  private onMouseEnterHunk = (hunkStartLine: number) => {
    if (this.state.selection !== undefined) {
      return
    }

    this.setState({ hoveredHunk: hunkStartLine })
  }

  private onMouseLeaveHunk = () => {
    this.setState({ hoveredHunk: undefined })
  }

  private onClickHunk = (hunkStartLine: number, select: boolean) => {
    if (!canSelect(this.props.file)) {
      return
    }

    const range = findInteractiveDiffRange(this.props.diff.hunks, hunkStartLine)
    if (range === null) {
      return
    }

    const { from, to } = range

    if (this.props.onIncludeChanged === undefined) {
      return
    }

    this.props.onIncludeChanged(
      this.props.file.selection.withRangeSelection(from, to - from + 1, select)
    )
  }

  private onContextMenuLine = (lineNumber: number) => {
    const file = this.props.file

    if (!canSelect(file)) {
      return
    }

    if (this.props.onDiscardChanges === undefined) {
      return
    }

    showContextualMenu([
      {
        label: 'Discard line',
        action: () => this.onDiscardChanges(file, lineNumber),
      },
    ])
  }

  private onContextMenuHunk = (hunkStartLine: number) => {
    const file = this.props.file

    if (!canSelect(file)) {
      return
    }

    if (this.props.onDiscardChanges === undefined) {
      return
    }

    const range = findInteractiveDiffRange(this.props.diff.hunks, hunkStartLine)

    if (range === null) {
      return
    }

    showContextualMenu([
      {
        label: 'Discard lines',
        action: () => this.onDiscardChanges(file, range.from, range.to),
      },
    ])
  }

  private onDiscardChanges(
    file: WorkingDirectoryFileChange,
    startLine: number,
    endLine: number = startLine
  ) {
    if (this.props.onDiscardChanges === undefined) {
      return
    }

    const selection = file.selection
      .withSelectNone()
      .withRangeSelection(startLine, endLine - startLine + 1, true)

    this.props.onDiscardChanges(this.props.diff, selection)
  }
}

/**
 * Checks to see if any key parameters in the props object that are used
 * when performing highlighting has changed. This is used to determine
 * whether highlighting should abort in between asynchronous operations
 * due to some factor (like which file is currently selected) have changed
 * and thus rendering the in-flight highlighting data useless.
 */
function highlightParametersEqual(
  newProps: ISideBySideDiffProps,
  prevProps: ISideBySideDiffProps
) {
  return (
    newProps === prevProps ||
    (newProps.file.id === prevProps.file.id &&
      newProps.diff.text === prevProps.diff.text)
  )
}

const getDiffRows = memoize(function (
  diff: ITextDiff,
  file: ChangedFile,
  temporarySelection?: ISelection
): DiffRow[] {
  const rows: DiffRow[] = []

  for (const hunk of diff.hunks) {
    rows.push(...getDiffRowsFromHunk(hunk, file, temporarySelection))
  }

  return rows
})

function getDiffRowsFromHunk(
  hunk: DiffHunk,
  file: ChangedFile,
  temporarySelection?: ISelection
): DiffRow[] {
  const rows: DiffRow[] = []
  let modifiedLines: {
    line: DiffLine
    lineNumber: number
  }[] = []

  for (const [num, line] of hunk.lines.entries()) {
    if (line.type === DiffLineType.Delete || line.type === DiffLineType.Add) {
      modifiedLines.push({
        line,
        lineNumber: hunk.unifiedDiffStart + num,
      })
      continue
    }

    if (modifiedLines.length > 0) {
      rows.push(...getModifiedRows(modifiedLines, file, temporarySelection))

      modifiedLines = []
    }

    if (line.type === DiffLineType.Hunk) {
      rows.push({
        type: DiffRowType.Hunk,
        content: line.content,
      })
      continue
    }

    if (line.type === DiffLineType.Context) {
      assertNonNullable(
        line.oldLineNumber,
        `Expecting oldLineNumber value for ${line}`
      )
      assertNonNullable(
        line.newLineNumber,
        `Expecting newLineNumber value for ${line}`
      )

      rows.push({
        type: DiffRowType.Context,
        content: line.content,
        beforeLineNumber: line.oldLineNumber,
        afterLineNumber: line.newLineNumber,
      })
      continue
    }

    assertNever(line.type, `Invalid line type: ${line.type}`)
  }

  if (modifiedLines.length > 0) {
    rows.push(...getModifiedRows(modifiedLines, file, temporarySelection))
  }

  return rows
}

function getModifiedRows(
  addedDeletedLines: ReadonlyArray<{
    line: DiffLine
    lineNumber: number
  }>,
  file: ChangedFile,
  temporarySelection?: ISelection
): ReadonlyArray<DiffRow> {
  if (addedDeletedLines.length === 0) {
    return []
  }
  const hunkStartLine = addedDeletedLines[0].lineNumber

  const addedLines = addedDeletedLines.filter(
    ({ line }) => line.type === DiffLineType.Add
  )
  const deletedLines = addedDeletedLines.filter(
    ({ line }) => line.type === DiffLineType.Delete
  )
  const shouldDisplayDiffInChunk = addedLines.length === deletedLines.length
  const output: Array<DiffRow> = []

  for (
    let numLine = 0;
    numLine < addedLines.length || numLine < deletedLines.length;
    numLine++
  ) {
    if (numLine < addedLines.length && numLine < deletedLines.length) {
      // Modified line
      output.push({
        type: DiffRowType.Modified,
        beforeData: getDataFromLine(
          deletedLines[numLine],
          'oldLineNumber',
          file,
          temporarySelection
        ),
        afterData: getDataFromLine(
          addedLines[numLine],
          'newLineNumber',
          file,
          temporarySelection
        ),
        hunkStartLine,
        displayDiffTokens: shouldDisplayDiffInChunk,
      })
    } else if (numLine < deletedLines.length) {
      // Deleted line
      output.push({
        type: DiffRowType.Deleted,
        data: getDataFromLine(
          deletedLines[numLine],
          'oldLineNumber',
          file,
          temporarySelection
        ),
        hunkStartLine,
      })
    } else if (numLine < addedLines.length) {
      // Added line
      output.push({
        type: DiffRowType.Added,
        data: getDataFromLine(
          addedLines[numLine],
          'newLineNumber',
          file,
          temporarySelection
        ),
        hunkStartLine,
      })
    }
  }

  return output
}

function getDataFromLine(
  { line, lineNumber }: { line: DiffLine; lineNumber: number },
  lineToUse: 'oldLineNumber' | 'newLineNumber',
  file: ChangedFile,
  temporarySelection?: ISelection
): IDiffRowData {
  return {
    content: line.content,
    lineNumber: forceUnwrap(
      `Expecting ${lineToUse} value for ${line}`,
      line[lineToUse]
    ),
    diffLineNumber: lineNumber,
    isSelected: isInSelection(lineNumber, file, temporarySelection),
    noNewLineIndicator: line.noTrailingNewLine,
  }
}

function isInSelection(
  diffLineNumber: number,
  file: ChangedFile,
  temporarySelection?: ISelection
) {
  if (!canSelect(file)) {
    return false
  }

  const isInStoredSelection = file.selection.isSelected(diffLineNumber)

  if (temporarySelection === undefined) {
    return isInStoredSelection
  }

  const isInTemporary = isInTemporarySelection(
    temporarySelection,
    diffLineNumber
  )

  if (temporarySelection.isSelected) {
    return isInStoredSelection || isInTemporary
  } else {
    return isInStoredSelection && !isInTemporary
  }
}
