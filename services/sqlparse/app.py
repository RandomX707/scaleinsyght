from typing import Literal

import sqlglot
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sqlglot import exp


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


class ParseRequest(BaseModel):
    sql: str = Field(min_length=1, max_length=100_000)
    dialect: Literal["postgres", "sql_server", "snowflake"]


app = FastAPI(title="Scale Insyght SQL parser", docs_url=None, redoc_url=None)


@app.post("/parse")
def parse_endpoint(request: ParseRequest) -> dict:
    try:
        return parse_sql(request.sql, request.dialect)
    except ParseError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
