# S1 click-through demo

This demo uses only the isolated local `si_test` application database and the fictional, read-only PostgreSQL source `si_testbed_pg`.

1. Start the native services and seed the isolated source, then start the app:

   ```sh
   pnpm demo:s1
   ```

   The command resets only `si_test`, migrates it, and starts the API, worker, and web app. It does not reset the development database.

2. In a second terminal, create a fresh tenant and first user. The command prompts for the password without echoing it and prints a tenant-specific sign-in link:

   ```sh
   pnpm tenant:create:test
   ```

3. Open the printed sign-in link, enter the first user's email and password, then create an invite from the profile menu. The invite token is masked in the app; use **Copy invite link** and open it in a private browser window to accept it.

4. Add a PostgreSQL connector from **Connectors**. Use the host, port, username, and password in the ignored `.env` variable `DATABASE_URL_TESTBED`; use database `si_testbed_pg`. The connector account is read-only. Keep the URL private.

5. Start profiling, then open **Profile**, **ER**, and **Dictionary**. Import `testbed/dictionary.csv`; the landing summary reports harvested and documented column coverage. Return to Home and ask “How many patients are in Testbed hospital?” to see the source, executed SQL, returned row count, and answer evidence.

Stop the services with Ctrl+C. Running `pnpm demo:s1` again resets only the isolated `si_test` application database and rebuilds the local testbed source. It does not populate any demo tenant or product records.
