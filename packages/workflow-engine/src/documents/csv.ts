import { DocumentError } from "./errors.js";

/**
 * An RFC 4180 reader: quoted fields (with `""` escapes and line breaks inside quotes), CRLF or LF rows, and a chosen
 * delimiter. Linear in the text; refuses more than `maxRows` rows rather than read part of the file silently.
 */
export function parseCsv(text: string, delimiter: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  const pushRow = () => {
    row.push(field);
    field = "";
    fieldStart = true;
    if (!(row.length === 1 && row[0] === "")) {
      rows.push(row);
      if (rows.length > maxRows) throw new DocumentError("too_large", `The CSV has more than ${maxRows} rows`);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
      fieldStart = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      pushRow();
    } else {
      field += char;
      fieldStart = false;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

/** One field as CSV writes it: quoted when it holds the delimiter, a quote or a line break. */
export function csvField(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
