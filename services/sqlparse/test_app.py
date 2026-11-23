import unittest

from app import ParseError, parse_sql


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


if __name__ == "__main__":
    unittest.main()
