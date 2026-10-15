// SPDX-License-Identifier: AGPL-3.0-or-later
/** A QR code as inline SVG (no data: URL, so the strict CSP holds). */
import { encode } from 'uqr';

export function Qr({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { ecc: 'M', border: 0 });
  const cells: preact.JSX.Element[] = [];
  for (const [y, row] of data.entries()) {
    for (const [x, on] of row.entries()) {
      if (on) cells.push(<rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} />);
    }
  }
  return (
    <svg class="qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      {cells}
    </svg>
  );
}
