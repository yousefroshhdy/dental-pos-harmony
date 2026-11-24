"use client";

import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandLoading } from "./command";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Second line (customer number, city…). */
  description?: string;
  /** Extra words cmdk matches on (codes, the other language's name). */
  keywords?: string[];
  disabled?: boolean;
}

export interface ComboboxProps {
  options: readonly ComboboxOption[];
  value: string | null;
  onValueChange: (value: string | null) => void;
  /** Trigger text when nothing is chosen. */
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  /** Form field name: renders a hidden input carrying the value, for server actions. */
  name?: string;
  id?: string;
  disabled?: boolean;
  /** "aria-invalid" on the trigger, set by FormField. */
  invalid?: boolean;
  "aria-describedby"?: string;
  /**
   * Server-side search: called with the typed text (debounce in the caller); the
   * caller replaces `options` with the results. Turns cmdk's own filtering off.
   */
  onSearch?: (query: string) => void;
  loading?: boolean;
  loadingText?: string;
  /** Allow clearing by choosing the selected option again. Default true. */
  clearable?: boolean;
  className?: string;
  renderOption?: (option: ComboboxOption) => ReactNode;
}

/**
 * Searchable single select (cmdk in a Radix popover), shadcn's combobox pattern.
 * Client-side filtering by default; pass `onSearch` for server search.
 */
export function Combobox({
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  name,
  id,
  disabled,
  invalid,
  onSearch,
  loading = false,
  loadingText,
  clearable = true,
  className,
  renderOption,
  ...rest
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-invalid={invalid || undefined}
            aria-describedby={rest["aria-describedby"]}
            disabled={disabled}
            className={cn("w-full justify-between px-3 font-normal", !selected && "text-muted-foreground", className)}
          >
            <span className="truncate">{selected ? selected.label : placeholder}</span>
            <ChevronsUpDownIcon aria-hidden="true" className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) min-w-64 p-0" align="start">
          <Command shouldFilter={!onSearch}>
            <CommandInput placeholder={searchPlaceholder} onValueChange={onSearch} />
            <CommandList id={listId}>
              {loading ? <CommandLoading>{loadingText ?? searchPlaceholder}</CommandLoading> : <CommandEmpty>{emptyText}</CommandEmpty>}
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    keywords={[option.label, ...(option.description ? [option.description] : []), ...(option.keywords ?? [])]}
                    disabled={option.disabled}
                    onSelect={(chosen) => {
                      onValueChange(clearable && chosen === value ? null : chosen);
                      setOpen(false);
                    }}
                  >
                    <CheckIcon aria-hidden="true" className={cn(option.value === value ? "opacity-100" : "opacity-0")} />
                    {renderOption ? (
                      renderOption(option)
                    ) : (
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{option.label}</span>
                        {option.description ? <span className="truncate text-xs text-muted-foreground">{option.description}</span> : null}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {name ? <input type="hidden" name={name} value={value ?? ""} /> : null}
    </>
  );
}
