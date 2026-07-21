import React, { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from './popover';
import { type Account } from '../../lib/db';

interface AccountComboboxProps {
  accounts: Account[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function AccountCombobox({
  accounts,
  value,
  onChange,
  placeholder = 'Selecione uma conta...',
  className
}: AccountComboboxProps) {
  const [open, setOpen] = useState(false);

  const selectedAccount = accounts.find((acc) => acc.code === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('w-full justify-between font-normal', className, !value && 'text-muted-foreground')}
        >
          {selectedAccount ? `${selectedAccount.code} - ${selectedAccount.description}` : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Buscar por código ou descrição..." />
          <CommandList>
            <CommandEmpty>Nenhuma conta encontrada.</CommandEmpty>
            <CommandGroup>
              {accounts.map((acc) => (
                <CommandItem
                  key={acc.id}
                  value={`${acc.code} ${acc.description}`}
                  onSelect={() => {
                    onChange(acc.code);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === acc.code ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="font-mono text-gray-500 mr-2">{acc.code}</span>
                  {acc.description}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
