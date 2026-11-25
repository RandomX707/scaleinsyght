import unittest

from app import ParseError, parse_sql, statement_lineage


class SqlParseContracts(unittest.TestCase):
    def test_parser_extracts_field_flow_and_scrubs_string_literals(self):
        parsed = parse_sql("SELECT customer_id AS customer_key FROM customer WHERE customer_id = 'SYNTHETIC_SECRET'", "postgres")
        self.assertIn({"source": "customer.customer_id", "target": "customer.customer_key"}, parsed["field_flows"])
        self.assertNotIn("SYNTHETIC_SECRET", parsed["scrubbed_sql"])

    def test_parser_rejects_unsupported_dialects_with_safe_error(self):
        with self.assertRaisesRegex(ParseError, "unsupported_dialect"):
            parse_sql("SELECT 1", "sqlite")

    def test_parser_reports_malformed_sql_without_echoing_source(self):
        with self.assertRaisesRegex(ParseError, "sql_parse_failed") as error:
            parse_sql("SELECT 'SYNTHETIC_SECRET' FROM", "postgres")
        self.assertNotIn("SYNTHETIC_SECRET", str(error.exception))

    def test_lineage_resolves_each_output_column_through_joins_and_aggregates(self):
        schema = {"analytics.stg_orders": {"order_id": "int", "department_id": "int", "amount": "numeric"},
                  "public.departments": {"department_id": "int", "department_name": "text"}}
        result = statement_lineage(
            'select d.department_name, count(o.order_id) as order_count, sum(o.amount) as order_amount '
            'from "db"."analytics"."stg_orders" o join "db"."public"."departments" d on o.department_id = d.department_id '
            "where o.amount > 100 group by d.department_name", "postgres", schema)
        self.assertEqual(result["reads"], ["analytics.stg_orders", "public.departments"])
        self.assertEqual(result["columns"], [
            {"column": "department_name", "kind": "direct", "sources": [{"table": "public.departments", "column": "department_name"}]},
            {"column": "order_count", "kind": "derived", "sources": [{"table": "analytics.stg_orders", "column": "order_id"}]},
            {"column": "order_amount", "kind": "derived", "sources": [{"table": "analytics.stg_orders", "column": "amount"}]},
        ])
        self.assertEqual(result["unresolved"], [])
        self.assertNotIn("100", str(result))

    def test_lineage_never_invents_sources_for_tables_outside_the_schema(self):
        result = statement_lineage("select o.order_id, c.claim_amount from analytics.stg_orders o left join billing.claims c on c.order_id = o.order_id",
                                   "postgres", {"analytics.stg_orders": {"order_id": "int"}})
        self.assertEqual(result["missing_tables"], ["billing.claims"])
        self.assertEqual(result["unresolved"], ["claim_amount"])

    def test_lineage_reads_sql_server_views(self):
        result = statement_lineage("SELECT d.department_id, COUNT_BIG(o.order_id) AS order_count FROM dbo.departments d "
                                   "LEFT JOIN dbo.orders o ON o.department_id = d.department_id GROUP BY d.department_id", "sql_server",
                                   {"dbo.departments": {"department_id": "int"}, "dbo.orders": {"order_id": "int", "department_id": "int"}})
        self.assertEqual([column["column"] for column in result["columns"]], ["department_id", "order_count"])


if __name__ == "__main__":
    unittest.main()
