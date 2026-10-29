# Attendance policy for the demonstration

These are agreed demo assumptions, pending confirmation by the project owner and faculty. Dates are local calendar dates in `Asia/Kolkata`, independent of the browser's timezone. Attendance entry for a future local date is rejected by the server.

Normally Monday–Friday have P1–P7 and weekends have no periods. An administrator can replace a date's eligible period set to represent a holiday, cancelled periods or a partial day. A calendar change that invalidates an existing attendance record is rejected. Enrollment start and end dates are inclusive, a student has at most one class membership on a date, and a transfer starts on its effective date after the preceding membership ends. Changes that would invalidate saved attendance are rejected. Deactivation preserves history; use an enrollment end date to stop eligibility.

For each student, the denominator is all scheduled eligible periods in the selected full calendar month intersected with the student's enrollment intervals. Missing marks are Unmarked and remain in the denominator: **Working = Present + Absent + Unmarked**. The current month's future eligible periods are included, so the report remains preliminary until they are marked. A report with any Unmarked periods is incomplete; it displays a preliminary percentage and does not receive a definitive low-attendance flag. CSV export includes Unmarked and completeness.

Percentage is `Present / Working × 100`, displayed to two decimals. With zero Working periods it is `N/A`. The default threshold is 75%, adjustable by an admin; a complete report is low only if its unrounded value is strictly less than the threshold. Corrections recalculate reports from the persisted data. A reason is required for changing a previously stored mark, including clearing to Unmarked; correction history remains available.

The source handover's illustrative complete calculations are 140/154 = 90.91%, 130/154 = 84.42%, 115/154 = 74.68%, and 150/154 = 97.40%. They are fixtures, not evidence of execution.
