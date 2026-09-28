import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { BackHandler } from "react-native";
import { phoneBackHandler } from "./phone-back";

/** While the screen is focused and shows a back chip, Android's hardware
 *  Back runs `clear` (the chip's action). A no-op elsewhere. */
export function usePhoneBack(showBack: boolean, clear: () => void): void {
  useFocusEffect(
    useCallback(() => {
      if (!showBack) return;
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        phoneBackHandler(showBack, clear),
      );
      return () => subscription.remove();
    }, [showBack, clear]),
  );
}
