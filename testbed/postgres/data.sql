INSERT INTO departments
SELECT n, 'D-' || lpad(n::text, 3, '0'), (ARRAY['Cardiology','Neurology','Emergency','Imaging','Laboratory','Surgery'])[ ((n - 1) % 6) + 1 ]
FROM generate_series(1, 6) AS n;

INSERT INTO providers
SELECT n, ((n - 1) % 6) + 1, 'Provider ' || lpad(n::text, 3, '0'),
       (ARRAY['General','Cardiology','Radiology','Surgery'])[ ((n - 1) % 4) + 1 ]
FROM generate_series(1, 24) AS n;

INSERT INTO patients
SELECT n, 'Patient ' || lpad(n::text, 4, '0'), date '1940-01-01' + ((n * 37) % 26000),
       'MRN-' || lpad(n::text, 6, '0'), CASE WHEN n % 7 = 0 THEN NULL ELSE '555-01' || lpad(n::text, 5, '0') END,
       timestamptz '2024-01-01 00:00:00+00' + n * interval '1 minute'
FROM generate_series(1, 500) AS n;

INSERT INTO encounters
SELECT n, ((n - 1) % 500) + 1, ((n - 1) % 6) + 1, ((n - 1) % 24) + 1,
       timestamptz '2025-01-01 00:00:00+00' + n * interval '1 hour',
       CASE WHEN n % 7 = 0 THEN NULL ELSE timestamptz '2025-01-01 00:00:00+00' + n * interval '1 hour' + interval '1 day' END
FROM generate_series(1, 700) AS n;

INSERT INTO orders
SELECT n, ((n - 1) % 700) + 1, ((n - 1) % 6) + 1,
       (ARRAY['lab','medication','imaging','procedure'])[ ((n - 1) % 4) + 1 ],
       (ARRAY['placed','completed','cancelled'])[ ((n - 1) % 3) + 1 ],
       timestamptz '2025-01-01 00:00:00+00' + n * interval '1 hour',
       ((n % 250) + 1)::numeric / 2
FROM generate_series(1, 1200) AS n;

ANALYZE;
