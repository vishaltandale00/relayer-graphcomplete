# Reference investigation

`sanitizeStatusCode` converts string input to a number and must reject any value
that is not an integer before applying the inclusive 100-599 range. Replacing
`Number.isInteger` with `Number.isFinite` lets values such as `200.5` and
`"200.5"` pass the sanitizer. They later reach the platform `Response` boundary,
where a non-integer status is invalid. Focused evidence is the sanitizer source,
its unit tests, and a reproduction that constructs the affected response path.
