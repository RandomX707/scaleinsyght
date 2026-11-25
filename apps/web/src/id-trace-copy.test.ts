import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { IdTrace, type IdEntity } from './id-trace.js';

it('shows equal coverage as a match without claiming either source created the ID', () => {
  const common = { connectorType:'postgres', distinct:100, tagged:true, format:'integer', probable:false, evidence:[] };
  const entity: IdEntity = {entityId:'id',label:'Patient ID',home:'a',fields:[
    {...common,assetId:'a',field:'public.patients.patient_id',sourceId:'pg',sourceName:'PostgreSQL',role:'created',sharedWithHome:null},
    {...common,assetId:'b',field:'dbo.patients.patient_id',sourceId:'sql',sourceName:'SQL Server',role:'kept',sharedWithHome:100,evidence:[
      {method:'inferred',explanation:'Matches the warehouse.',confidence:1},
      {method:'inferred',explanation:'Matches the warehouse;',confidence:1},
    ]},
  ]};
  const html = renderToStaticMarkup(createElement(IdTrace,{entities:[entity],lookup:async()=>[]}));
  expect(html).toContain('Origin unclear');
  expect(html).toContain('100 of 100 (100%)');
  expect(html).toContain('patients.<wbr/>patient_id');
  expect(html).not.toContain('Where the ID is created');
  expect(html.match(/Matches the warehouse\./g)).toHaveLength(1);
  expect(html).not.toContain('.;');
});
