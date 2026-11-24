import ExcelJS from 'exceljs';
import { describe,expect,it } from 'vitest';
import { parseDictionaryFile } from '../../apps/api/src/dictionary-file.js';

describe('dictionary import file parser',()=>{
  it('parses quoted CSV descriptions and validates required columns',async()=>{
    await expect(parseDictionaryFile({format:'csv',bytes:Buffer.from('table,column,description\npatients,name,"Name, as recorded"\n')})).resolves.toEqual([{table:'patients',column:'name',description:'Name, as recorded'}]);
    await expect(parseDictionaryFile({format:'csv',bytes:Buffer.from('table,column\npatients,name\n')})).rejects.toThrow('dictionary_headers_invalid');
  });
  it('reads published Excel workbooks and rejects duplicate descriptions',async()=>{
    const workbook=new ExcelJS.Workbook();const sheet=workbook.addWorksheet('Dictionary');sheet.addRow(['table','column','description']);sheet.addRow(['patients','name','Patient name']);const bytes=Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(parseDictionaryFile({format:'xlsx',bytes})).resolves.toEqual([{table:'patients',column:'name',description:'Patient name'}]);
    await expect(parseDictionaryFile({format:'csv',bytes:Buffer.from('table,column,description\npatients,name,A\npatients,name,B\n')})).rejects.toThrow('dictionary_duplicate_column');
  });
});
