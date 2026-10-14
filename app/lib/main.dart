import 'package:flutter/material.dart';

import 'chat_screen.dart';
import 'db.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized(); // needed before plugins run (sqflite)
  await openDb();
  runApp(
    MaterialApp(
      title: 'ESPeak Hub',
      debugShowCheckedModeBanner: false,
      // true black like the OLED she lives on; app bar blends into it
      theme: ThemeData(
        colorSchemeSeed: Colors.teal,
        brightness: Brightness.dark,
        scaffoldBackgroundColor: Colors.black,
        appBarTheme: const AppBarTheme(backgroundColor: Colors.black, scrolledUnderElevation: 0),
        drawerTheme: const DrawerThemeData(backgroundColor: Color(0xFF0B0F10)),
        snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
      ),
      home: const ChatScreen(),
    ),
  );
}
