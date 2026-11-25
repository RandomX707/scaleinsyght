from typing import Literal

import sqlglot
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sqlglot import exp
from sqlglot.lineage import lineage as column_lineage
from sqlglot.optimizer.qualify import qualify
from sqlglot.optimizer.scope import build_scope


class ParseError(ValueError):
    pass


def parse_sql(sql: str, dialect: str) -> dict:
    dialects = {"postgres": "postgres", "sql_server": "tsql", "snowflake": "snowflake"}
    if dialect not in dialects:
        raise ParseError("unsupported_dialect")
    if not isinstance(sql, str) or not sql.strip() or len(sql) > 100_000:
        raise ParseError("invalid_sql_input")
    try:
        trees = sqlglot.parse(sql, read=dialects[dialect])
    except Exception as error:
        raise ParseError("sql_parse_failed") from error
    if len(trees) != 1 or trees[0] is None or not isinstance(trees[0], exp.Select):
        raise ParseError("unsupported_sql_statement")
    tree = trees[0]
    source = tree.find(exp.From)
    table = source.this.alias_or_name if source and isinstance(source.this, (exp.Table, exp.Subquery)) else "source"
    flows = []
    for projection in tree.expressions:
        expression = projection.this if isinstance(projection, exp.Alias) else projection
        alias = projection.alias_or_name
        if isinstance(expression, exp.Column):
            qualifier = expression.table or table
            flows.append({"source": f"{qualifier}.{expression.name}", "target": f"{table}.{alias or expression.name}"})
    scrubbed = tree.transform(
        lambda node: exp.Literal(this="?", is_string=False) if isinstance(node, exp.Literal) else node,
    )
    return {"field_flows": flows, "scrubbed_sql": scrubbed.sql(dialect=dialects[dialect])}


DIALECTS = {"postgres": "postgres", "sql_server": "tsql", "snowflake": "snowflake"}


def _table_name(table: exp.Table) -> str:
    """schema.table, dropping any database or catalog part."""
    return f"{table.db}.{table.name}" if table.db else table.name


def statement_lineage(sql: str, dialect: str, schema: dict, default_schema: str | None = None) -> dict:
    """Column lineage of one SELECT (a view body or a dbt model's compiled SQL).

    schema maps "schema.table" to {column: type} for every table the statement may read. Each output column lists
    the source columns it is computed from and whether it is a direct copy or derived (expression or aggregate).
    Columns whose sources cannot be resolved against the schema are listed as unresolved, never guessed. Only names
    leave this function: literals and the SQL text itself are not returned.
    """
    if dialect not in DIALECTS:
        raise ParseError("unsupported_dialect")
    if not isinstance(sql, str) or not sql.strip() or len(sql) > 100_000:
        raise ParseError("invalid_sql_input")
    read = DIALECTS[dialect]
    try:
        trees = sqlglot.parse(sql, read=read)
    except Exception as error:
        raise ParseError("sql_parse_failed") from error
    if len(trees) != 1 or trees[0] is None:
        raise ParseError("unsupported_sql_statement")
    tree = trees[0]
    # A view definition may arrive as its CREATE VIEW statement (SQL Server modules); lineage reads its query.
    if isinstance(tree, exp.Create) and str(tree.args.get("kind", "")).upper() == "VIEW":
        tree = tree.expression
    if not isinstance(tree, (exp.Select, exp.Union)):
        raise ParseError("unsupported_sql_statement")
    for table in tree.find_all(exp.Table):
        table.set("catalog", None)
        if default_schema and not table.db and table.name:
            table.set("db", exp.to_identifier(default_schema))
    nested: dict = {}
    for name, columns in schema.items():
        parts = name.split(".")
        if len(parts) != 2:
            raise ParseError("invalid_schema")
        nested.setdefault(parts[0], {})[parts[1]] = dict(columns)
    known = set(schema)
    reads = sorted({_table_name(table) for table in tree.find_all(exp.Table) if table.name})
    missing = [name for name in reads if name not in known]
    try:
        qualified = qualify(tree.copy(), schema=nested, dialect=read, validate_qualify_columns=False)
    except Exception as error:
        raise ParseError("sql_qualify_failed") from error
    columns = []
    unresolved = []
    for projection in qualified.selects:
        name = projection.alias_or_name
        try:
            node = column_lineage(name, qualified, schema=nested, dialect=read)
        except Exception:
            unresolved.append(name)
            continue
        sources = set()
        for leaf in node.walk():
            if leaf.downstream:
                continue
            if isinstance(leaf.expression, exp.Table):
                table = _table_name(leaf.expression)
                column = leaf.name.split(".")[-1].strip('"').strip("`[]")
                if table in known and column in schema[table]:
                    sources.add((table, column))
        expression = projection.this if isinstance(projection, exp.Alias) else projection
        kind = "direct" if isinstance(expression, exp.Column) else "derived"
        if not sources:
            unresolved.append(name)
            continue
        columns.append({"column": name, "kind": kind, "sources": [{"table": t, "column": c} for t, c in sorted(sources)]})
    return {"reads": reads, "missing_tables": missing, "columns": columns, "unresolved": unresolved}


class LineageRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=100_000)
    dialect: Literal["postgres", "sql_server", "snowflake"]
    tables: dict[str, dict[str, str]] = Field(max_length=2_000)
    default_schema: str | None = Field(default=None, max_length=128)


class ParseRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=100_000)
    dialect: Literal["postgres", "sql_server", "snowflake"]


app = FastAPI(title="Scale Insyght SQL parser", docs_url=None, redoc_url=None)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/lineage")
def lineage_endpoint(request: LineageRequest) -> dict:
    try:
        return statement_lineage(request.sql, request.dialect, request.tables, request.default_schema)
    except ParseError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/parse")
def parse_endpoint(request: ParseRequest) -> dict:
    try:
        return parse_sql(request.sql, request.dialect)
    except ParseError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
