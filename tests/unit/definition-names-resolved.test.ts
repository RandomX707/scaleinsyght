import { describe, expect, it } from 'vitest';
import { analyseDefinition, type DefinitionCatalog } from '@scaleinsyght/profiler';

// Every name a definition mentions is resolved against the source's harvested catalog: only real tables and views are
// reads or writes, routines are calls, CTEs, temp tables, table variables, aliases and records are never objects, and a
// schema-qualified name the catalog does not have is reported as unresolved. Generic fixtures; no client SQL.
describe('PostgreSQL function', () => {
  const catalog: DefinitionCatalog = {
    relations: ['sales.orders', 'sales.customers', 'sales.order_lines', 'report.daily_totals'],
    routines: ['util.split_list(p_text text, p_sep text)', 'util.fiscal_year(p_day date)', 'report.refresh_totals(p_day date)'],
  };
  const text = `CREATE OR REPLACE FUNCTION report.orders_by_customer(p_ids text, p_day date)
 RETURNS TABLE(customer_name text, order_count bigint) LANGUAGE plpgsql AS $function$
DECLARE rec record;
BEGIN
  CREATE TEMP TABLE tmp_ids AS SELECT item::int AS id FROM util.split_list(p_ids, '<string>') AS item;
  FOR rec IN SELECT o.order_id FROM sales.orders o LOOP NULL; END LOOP;
  PERFORM report.refresh_totals(p_day);
  RETURN QUERY
  WITH picked AS (SELECT c.customer_id, c.name FROM sales.customers c JOIN tmp_ids t ON t.id = c.customer_id),
       lines AS MATERIALIZED (SELECT l.order_id FROM sales.order_lines l)
  SELECT p.name, count(*) FROM picked p JOIN sales.orders o ON o.customer_id = p.customer_id
  JOIN lines ON lines.order_id = o.order_id
  WHERE util.fiscal_year(o.ordered_on) = util.fiscal_year(p_day) GROUP BY p.name;
  INSERT INTO report.daily_totals SELECT p_day, count(*) FROM sales.orders;
  SELECT count(*) INTO rec FROM missing_schema.old_orders;
END $function$`;
  it('reads only real tables, calls the routines it uses, and drops CTEs, temp tables, aliases and records', () => {
    const analysis = analyseDefinition({ name: 'report.orders_by_customer', text, defaultSchema: 'public', catalog });
    expect(analysis.reads).toEqual(['sales.customers', 'sales.order_lines', 'sales.orders']);
    expect(analysis.writes).toEqual([{ table: 'report.daily_totals', mode: 'insert' }]);
    expect(analysis.calls).toEqual(['report.refresh_totals(p_day date)', 'util.fiscal_year(p_day date)', 'util.split_list(p_text text, p_sep text)']);
    expect(analysis.unresolved).toEqual(['missing_schema.old_orders']);
    // The plain step list names only real tables too.
    for (const step of analysis.steps) for (const name of step.match(/\b[\w]+\.[\w]+\b/g) ?? []) expect([...catalog.relations, 'public.lines', 'public.picked'].slice(0, 4), step).toContain(name);
  });
});

describe('SQL Server procedure', () => {
  const catalog: DefinitionCatalog = {
    relations: ['dbo.Orders', 'dbo.Customers', 'dbo.OrderSummary'],
    routines: ['dbo.usp_WriteLog', 'dbo.fn_Region', 'dbo.fn_SplitIds'],
  };
  const text = `CREATE PROCEDURE dbo.usp_LoadOrderSummary @Ids nvarchar(max) AS
BEGIN
  DECLARE @picked TABLE (CustomerId int);
  INSERT INTO @picked (CustomerId) SELECT value FROM dbo.fn_SplitIds(@Ids);
  SELECT o.OrderId INTO #recent FROM dbo.Orders AS o WHERE o.OrderDate > <number>;
  WITH totals AS (SELECT c.CustomerId, COUNT(*) AS n FROM [dbo].[Customers] c JOIN #recent r ON r.OrderId = c.CustomerId GROUP BY c.CustomerId)
  MERGE dbo.OrderSummary AS target USING totals AS source ON target.CustomerId = source.CustomerId
    WHEN MATCHED THEN UPDATE SET target.Total = source.n, target.Region = dbo.fn_Region(source.CustomerId)
    WHEN NOT MATCHED THEN INSERT (CustomerId, Total) VALUES (source.CustomerId, source.n);
  SELECT * FROM @picked p JOIN Customers cu ON cu.CustomerId = p.CustomerId;
  EXEC dbo.usp_WriteLog @Name = N'<string>';
  EXEC archive.usp_Gone;
END`;
  it('reads only real tables, calls the routines it uses, and drops CTEs, temp tables, table variables and aliases', () => {
    const analysis = analyseDefinition({ name: 'dbo.usp_LoadOrderSummary', text, defaultSchema: 'dbo', catalog });
    expect(analysis.reads).toEqual(['dbo.Customers', 'dbo.Orders']);
    expect(analysis.writes).toEqual([{ table: 'dbo.OrderSummary', mode: 'merge' }]);
    expect(analysis.calls).toEqual(['dbo.fn_Region', 'dbo.fn_SplitIds', 'dbo.usp_WriteLog']);
    expect(analysis.unresolved).toEqual(['archive.usp_Gone']);
  });
});

describe('without a catalog', () => {
  it('still drops CTEs and temp tables and treats a function in FROM as a call', () => {
    const analysis = analyseDefinition({ name: 'dbo.p', text: 'WITH x AS (SELECT 1 AS a FROM dbo.t) SELECT * FROM x JOIN #tmp ON 1=1 CROSS JOIN dbo.f_rows(1) JOIN dbo.u ON 1=1', defaultSchema: 'dbo' });
    expect(analysis.reads).toEqual(['dbo.t', 'dbo.u']);
    expect(analysis.calls).toEqual(['dbo.f_rows']);
  });
});
