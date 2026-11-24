import ExcelJS from 'exceljs';

export type DictionaryRow={table:string;column:string;description:string};
function parseCsv(text:string):string[][]{
  const rows:string[][]=[];let row:string[]=[];let cell='';let quoted=false;
  for(let i=0;i<text.length;i++){const ch=text[i]!;
    if(quoted){if(ch==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(ch==='"')quoted=false;else cell+=ch;continue;}
    if(ch==='"'&&cell.length===0){quoted=true;continue;}
    if(ch===','){row.push(cell);cell='';continue;}
    if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(cell);if(row.some(value=>value.length>0))rows.push(row);row=[];cell='';continue;}
    cell+=ch;
  }
  if(quoted)throw new Error('dictionary_csv_unclosed_quote');if(cell.length||row.length){row.push(cell);if(row.some(value=>value.length>0))rows.push(row);}return rows;
}
function normalize(rows:string[][]):DictionaryRow[]{
  if(!rows.length)throw new Error('dictionary_file_empty');
  const headers=rows[0]!.map(value=>value.replace(/^\uFEFF/,'').trim().toLowerCase());
  if(headers.join(',')!=='table,column,description')throw new Error('dictionary_headers_invalid');
  const result:DictionaryRow[]=[];const seen=new Set<string>();
  for(const [index,row] of rows.slice(1).entries()){
    if(row.length!==3)throw new Error(`dictionary_row_invalid:${index+2}`);
    const [table,column,description]=row.map(value=>value.trim());
    if(!table||!column||!description||description.length>2000)throw new Error(`dictionary_row_invalid:${index+2}`);
    const key=`${table}\0${column}`;if(seen.has(key))throw new Error(`dictionary_duplicate_column:${index+2}`);seen.add(key);result.push({table:table!,column:column!,description:description!});
  }
  if(!result.length)throw new Error('dictionary_file_has_no_rows');return result;
}
export async function parseDictionaryFile(input:{format:'csv'|'xlsx';bytes:Buffer}):Promise<DictionaryRow[]>{
  if(input.bytes.length===0||input.bytes.length>5_000_000)throw new Error('dictionary_file_size_invalid');
  if(input.format==='csv')return normalize(parseCsv(input.bytes.toString('utf8')));
  const workbook=new ExcelJS.Workbook();const arrayBuffer=input.bytes.buffer.slice(input.bytes.byteOffset,input.bytes.byteOffset+input.bytes.byteLength) as ArrayBuffer;await workbook.xlsx.load(arrayBuffer);
  const sheet=workbook.worksheets[0];if(!sheet)throw new Error('dictionary_file_empty');const rows:string[][]=[];
  const cellText=(value:ExcelJS.CellValue):string=>{if(value===null||value===undefined)return '';if(typeof value==='object'){if('text'in value)return String(value.text);if('richText'in value)return value.richText.map(part=>part.text).join('');if('result'in value)return String(value.result??'');return '';}return String(value);};
  sheet.eachRow({includeEmpty:false},row=>{const values:string[]=[];for(let index=1;index<=row.cellCount;index++)values.push(cellText(row.getCell(index).value));rows.push(values);});
  return normalize(rows);
}
