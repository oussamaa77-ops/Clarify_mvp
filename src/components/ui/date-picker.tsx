"use client";

import * as React from "react";
import { addMonths, format, getDay, getDaysInMonth, isSameDay, startOfMonth } from "date-fns";
import { fr } from "date-fns/locale";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// DatePicker shadcn (autonome, sans react-day-picker) : bouton affichant la date au
// format JJ/MM/AAAA, mini-calendrier fr dans un Popover. `value`/`onChange` en ISO
// court (AAAA-MM-JJ) pour coller à la BDD, sans décalage de fuseau (dates locales).
export interface DatePickerProps {
  value?: string | null;                       // ISO court "AAAA-MM-JJ" ou null
  onChange: (iso: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  clearable?: boolean;
}

function isoToDate(iso?: string | null): Date | undefined {
  if (!iso) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return undefined;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); // minuit local → pas de décalage
}

const WEEKDAYS = ["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"];

export function DatePicker({
  value, onChange, placeholder = "JJ/MM/AAAA", disabled, className, clearable = true,
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false);
  const selected = isoToDate(value);
  const [view, setView] = React.useState<Date>(startOfMonth(selected ?? new Date()));

  React.useEffect(() => { if (selected) setView(startOfMonth(selected)); }, [value]);

  const first = startOfMonth(view);
  const offset = (getDay(first) + 6) % 7;          // lundi = 0
  const nbDays = getDaysInMonth(view);
  const cells: Array<Date | null> = [
    ...Array.from({ length: offset }, () => null),
    ...Array.from({ length: nbDays }, (_, i) => new Date(view.getFullYear(), view.getMonth(), i + 1)),
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn("w-full justify-start text-left font-normal", !selected && "text-muted-foreground", className)}
        >
          <CalendarIcon className="mr-2 h-4 w-4 shrink-0" />
          {selected ? format(selected, "dd/MM/yyyy", { locale: fr }) : <span>{placeholder}</span>}
          {clearable && selected && (
            <X
              className="ml-auto h-3.5 w-3.5 opacity-60 hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); onChange(null); }}
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        {/* En-tête mois + navigation */}
        <div className="flex items-center justify-between mb-2">
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setView(addMonths(view, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium capitalize">{format(view, "LLLL yyyy", { locale: fr })}</span>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setView(addMonths(view, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        {/* Jours de la semaine */}
        <div className="grid grid-cols-7 gap-0.5 mb-1">
          {WEEKDAYS.map((d) => (
            <div key={d} className="h-7 w-8 text-center text-[11px] font-medium text-muted-foreground flex items-center justify-center">{d}</div>
          ))}
        </div>
        {/* Grille des jours */}
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((d, i) => d === null ? <div key={i} className="h-8 w-8" /> : (
            <button
              key={i}
              type="button"
              onClick={() => { onChange(format(d, "yyyy-MM-dd")); setOpen(false); }}
              className={cn(
                "h-8 w-8 rounded-md text-sm hover:bg-accent transition-colors",
                selected && isSameDay(d, selected) ? "bg-primary text-primary-foreground hover:bg-primary" : "",
              )}
            >
              {d.getDate()}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
