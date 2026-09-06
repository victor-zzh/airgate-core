import { HopLoader } from '../ui/HopLoader';

export function TableLoadingRow({
  colSpan,
  minHeight = 220,
}: {
  colSpan: number;
  minHeight?: number;
}) {
  return (
    <tr data-key="loading" data-slot="tr">
      <td colSpan={colSpan} data-slot="td">
        <div aria-busy="true" className="ag-hop-block w-full" style={{ minHeight }}>
          <HopLoader size="lg" />
        </div>
      </td>
    </tr>
  );
}
