/**
 * Compatibility barrel for the screens written before Phase P. Every export keeps
 * its name and props; the implementations now live in the shadcn/ui components
 * next to this file. New code imports from those files directly:
 *
 *   Input → ./input, Select (native <select>) → ./native-select (NativeSelect),
 *   Label → ./label, Card / CardTitle → ./card, Badge (tone) → ./badge,
 *   Table / Th / Td → ./table, Alert (tone) → ./alert.
 *
 * Note: `Select` here is the native <select>; the Radix select is `Select` in ./select.
 */
export { Input } from "./input";
export { NativeSelect as Select } from "./native-select";
export { Label } from "./label";
export { Card, CardTitle } from "./card";
export { Badge } from "./badge";
export { Table, Th, Td } from "./table";
export { Alert } from "./alert";
