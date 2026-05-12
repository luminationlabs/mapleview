import { useCallback, useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { buildCalendarGrid, parseYMD, todayStr } from "../utils/calendar";

export interface DatePickerModalProps {
  visible: boolean;
  onClose: () => void;
  onSelectDate: (dateStr: string) => void; // "YYYY-MM-DD"
  selectedDate: string; // current selection
  availableDates: Set<string>; // dates with recordings
}

const ACCENT = "#0A84FF";
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function DatePickerModal({
  visible,
  onClose,
  onSelectDate,
  selectedDate,
  availableDates,
}: DatePickerModalProps) {
  const { year: selYear, month: selMonth } = parseYMD(selectedDate);

  const [viewYear, setViewYear] = useState(selYear);
  const [viewMonth, setViewMonth] = useState(selMonth);

  // Reset view to selected date's month when modal opens
  const [lastVisible, setLastVisible] = useState(false);
  if (visible && !lastVisible) {
    const parsed = parseYMD(selectedDate);
    setViewYear(parsed.year);
    setViewMonth(parsed.month);
  }
  if (visible !== lastVisible) {
    setLastVisible(visible);
  }

  const today = useMemo(() => todayStr(), []);

  const rows = useMemo(
    () => buildCalendarGrid(viewYear, viewMonth),
    [viewYear, viewMonth],
  );

  const goToPrevMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m === 0) {
        setViewYear((y) => y - 1);
        return 11;
      }
      return m - 1;
    });
  }, []);

  const goToNextMonth = useCallback(() => {
    setViewMonth((m) => {
      if (m === 11) {
        setViewYear((y) => y + 1);
        return 0;
      }
      return m + 1;
    });
  }, []);

  const handleDayPress = useCallback(
    (dateStr: string) => {
      onSelectDate(dateStr);
    },
    [onSelectDate],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          {/* Month/Year header with arrows */}
          <View style={styles.header}>
            <Pressable onPress={goToPrevMonth} hitSlop={12} style={styles.arrowBtn}>
              <Ionicons name="chevron-back" size={22} color="#FFFFFF" />
            </Pressable>
            <Text style={styles.headerTitle}>
              {MONTH_NAMES[viewMonth]} {viewYear}
            </Text>
            <Pressable onPress={goToNextMonth} hitSlop={12} style={styles.arrowBtn}>
              <Ionicons name="chevron-forward" size={22} color="#FFFFFF" />
            </Pressable>
          </View>

          {/* Day-of-week labels */}
          <View style={styles.weekRow}>
            {DAY_LABELS.map((label, i) => (
              <View key={i} style={styles.dayCell}>
                <Text style={styles.weekLabel}>{label}</Text>
              </View>
            ))}
          </View>

          {/* Calendar grid */}
          {rows.map((row, rowIdx) => (
            <View key={rowIdx} style={styles.weekRow}>
              {row.map((cell, colIdx) => {
                if (!cell) {
                  return <View key={colIdx} style={styles.dayCell} />;
                }

                const isSelected = cell.dateStr === selectedDate;
                const isAvailable = availableDates.has(cell.dateStr);
                const isToday = cell.dateStr === today;

                return (
                  <View key={colIdx} style={styles.dayCell}>
                    <Pressable
                      onPress={
                        isAvailable ? () => handleDayPress(cell.dateStr) : undefined
                      }
                      disabled={!isAvailable}
                      style={[
                        styles.dayButton,
                        isSelected && styles.dayButtonSelected,
                        isToday && !isSelected && styles.dayButtonToday,
                      ]}
                    >
                      <Text
                        style={[
                          styles.dayText,
                          isAvailable && styles.dayTextAvailable,
                          isSelected && styles.dayTextSelected,
                          !isAvailable && styles.dayTextUnavailable,
                        ]}
                      >
                        {cell.day}
                      </Text>
                    </Pressable>
                    {isAvailable && !isSelected && (
                      <View style={styles.dot} />
                    )}
                  </View>
                );
              })}
            </View>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const CELL_SIZE = 40;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
  },
  card: {
    width: 320,
    backgroundColor: "#1C1C1E",
    borderRadius: 14,
    paddingVertical: 16,
    paddingHorizontal: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  arrowBtn: {
    padding: 4,
  },
  headerTitle: {
    color: "#FFFFFF",
    fontSize: 17,
    fontWeight: "600",
  },
  weekRow: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  weekLabel: {
    color: "#8E8E93",
    fontSize: 13,
    fontWeight: "500",
    textAlign: "center",
  },
  dayCell: {
    width: CELL_SIZE,
    height: CELL_SIZE + 6,
    alignItems: "center",
    justifyContent: "flex-start",
  },
  dayButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  dayButtonSelected: {
    backgroundColor: ACCENT,
  },
  dayButtonToday: {
    borderWidth: 1,
    borderColor: "#48484A",
  },
  dayText: {
    fontSize: 15,
    fontWeight: "400",
  },
  dayTextAvailable: {
    color: "#FFFFFF",
  },
  dayTextSelected: {
    color: "#FFFFFF",
    fontWeight: "600",
  },
  dayTextUnavailable: {
    color: "#3A3A3C",
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: ACCENT,
    marginTop: 1,
  },
});
