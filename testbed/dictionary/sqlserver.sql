-- Dictionary testbed (SQL Server): standard tables, customer-built X_ objects, procedures of each kind, a view, an
-- encrypted procedure and a procedure that calls another. Fictional data. Expected content: testbed/dictionary/truth.json.
CREATE TABLE dbo.departments (department_id int NOT NULL PRIMARY KEY, department_name nvarchar(80) NOT NULL);
CREATE TABLE dbo.patients (patient_id int NOT NULL PRIMARY KEY, mrn nvarchar(20) NOT NULL, full_name nvarchar(120) NOT NULL);
CREATE TABLE dbo.encounters (
  encounter_id int NOT NULL PRIMARY KEY,
  patient_id int NOT NULL REFERENCES dbo.patients(patient_id),
  department_id int NOT NULL REFERENCES dbo.departments(department_id),
  admitted_at datetime2(0) NOT NULL,
  discharged_at datetime2(0) NULL
);
CREATE INDEX ix_encounters_patient ON dbo.encounters(patient_id);
CREATE TABLE dbo.X_READMIT_FLAGS (encounter_id int NOT NULL PRIMARY KEY, readmitted char(1) NOT NULL, flagged_at datetime2(0) NOT NULL);
CREATE TABLE dbo.X_CENSUS_SNAP (snap_date date NOT NULL, department_id int NOT NULL, census_count int NOT NULL, PRIMARY KEY (snap_date, department_id));
CREATE TABLE dbo.X_CENSUS_SNAP_ARCH (snap_date date NOT NULL, department_id int NOT NULL, census_count int NOT NULL);
CREATE TABLE dbo.X_JOB_LOG (job_name nvarchar(80) NOT NULL, ran_at datetime2(0) NOT NULL, row_count int NOT NULL);
GO
CREATE VIEW dbo.X_V_DEPT_CENSUS AS
  SELECT d.department_name, s.snap_date, s.census_count FROM dbo.X_CENSUS_SNAP s JOIN dbo.departments d ON d.department_id = s.department_id;
GO
CREATE PROCEDURE dbo.usp_X_LOG_JOB @JobName nvarchar(80), @Rows int AS
BEGIN
  INSERT INTO dbo.X_JOB_LOG (job_name, ran_at, row_count) VALUES (@JobName, SYSUTCDATETIME(), @Rows);
END;
GO
CREATE PROCEDURE dbo.usp_X_LOAD_READMIT_FLAGS @LookbackDays int = 30 AS
BEGIN
  TRUNCATE TABLE dbo.X_READMIT_FLAGS;
  INSERT INTO dbo.X_READMIT_FLAGS (encounter_id, readmitted, flagged_at)
  SELECT e.encounter_id,
         CASE WHEN EXISTS (SELECT 1 FROM dbo.encounters n WHERE n.patient_id = e.patient_id AND n.admitted_at > e.discharged_at
                           AND n.admitted_at <= DATEADD(day, @LookbackDays, e.discharged_at)) THEN 'Y' ELSE 'N' END,
         SYSUTCDATETIME()
  FROM dbo.encounters e WHERE e.discharged_at IS NOT NULL AND e.patient_id <> 104233;
  DECLARE @n int = @@ROWCOUNT;
  EXEC dbo.usp_X_LOG_JOB @JobName = 'readmit flags', @Rows = @n;
END;
GO
CREATE PROCEDURE dbo.usp_X_MERGE_CENSUS @SnapDate date AS
BEGIN
  MERGE dbo.X_CENSUS_SNAP AS t
  USING (SELECT department_id, COUNT(*) AS census_count FROM dbo.encounters WHERE admitted_at <= @SnapDate AND (discharged_at IS NULL OR discharged_at > @SnapDate) GROUP BY department_id) AS s
  ON t.snap_date = @SnapDate AND t.department_id = s.department_id
  WHEN MATCHED THEN UPDATE SET census_count = s.census_count
  WHEN NOT MATCHED THEN INSERT (snap_date, department_id, census_count) VALUES (@SnapDate, s.department_id, s.census_count);
END;
GO
CREATE PROCEDURE dbo.rpt_X_ENCOUNTERS_BY_DEPT @From date, @To date AS
BEGIN
  SELECT d.department_name, COUNT(*) AS encounters FROM dbo.encounters e JOIN dbo.departments d ON d.department_id = e.department_id
  WHERE e.admitted_at >= @From AND e.admitted_at < @To GROUP BY d.department_name;
END;
GO
CREATE PROCEDURE dbo.usp_X_CHECK_CENSUS AS
BEGIN
  SELECT COUNT(*) AS negative_rows FROM dbo.X_CENSUS_SNAP WHERE census_count < 0;
END;
GO
CREATE PROCEDURE dbo.usp_X_ARCHIVE_CENSUS @Before date AS
BEGIN
  INSERT INTO dbo.X_CENSUS_SNAP_ARCH (snap_date, department_id, census_count) SELECT snap_date, department_id, census_count FROM dbo.X_CENSUS_SNAP WHERE snap_date < @Before;
  DELETE FROM dbo.X_CENSUS_SNAP WHERE snap_date < @Before;
END;
GO
CREATE PROCEDURE dbo.usp_X_SECRET_SCORE WITH ENCRYPTION AS
BEGIN
  SELECT COUNT(*) FROM dbo.encounters;
END;
GO
-- Decision 64: an inline table-valued function. Its 3 inputs are parameters; its 4 returned columns are not.
CREATE FUNCTION dbo.fn_X_PATIENT_STAYS (@PatientId int, @From date, @To date)
RETURNS TABLE AS RETURN
  SELECT e.encounter_id, e.department_id, e.admitted_at, e.discharged_at FROM dbo.encounters e
  WHERE e.patient_id = @PatientId AND e.admitted_at >= @From AND e.admitted_at < @To;
GO
INSERT INTO dbo.departments VALUES (1, N'Emergency'), (2, N'Cardiology'), (3, N'Pediatrics');
INSERT INTO dbo.patients VALUES (1, N'MRN-0001', N'Synthetic Patient One'), (2, N'MRN-0002', N'Synthetic Patient Two'), (3, N'MRN-0003', N'Synthetic Patient Three');
INSERT INTO dbo.encounters VALUES (1, 1, 1, '2025-01-02', '2025-01-04'), (2, 1, 1, '2025-01-20', '2025-01-21'), (3, 2, 2, '2025-02-01', NULL), (4, 3, 3, '2025-03-05', '2025-03-06');
